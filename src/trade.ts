import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { curveAbi, curveBuyEvent, factoryAbi } from "./abi.js";
import { amountOut, applySlippage, quoteBuySequence, type CurveSnapshot } from "./quote.js";
import { readCurveSnapshot } from "./protocol.js";
import { unwrapError } from "./tx.js";
import type { StoredWallet } from "./wallets.js";

export async function resolveCurve(
  client: PublicClient,
  factory: Address,
  token: Address,
): Promise<{ curve: Address; pairToken: Address; phase: number }> {
  const launched = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
  if (!launched.exists) throw new Error(`Token ${token} is not a pons v2 launch on this factory`);
  if (launched.phase !== 0) {
    throw new Error(`Launch phase is ${launched.phase}; curve trades are only for phase 0`);
  }
  return { curve: launched.curve, pairToken: launched.pairToken, phase: launched.phase };
}

export async function quoteWalletBuys(input: {
  publicClient: PublicClient;
  curve: Address;
  recipients: Address[];
  amounts: bigint[];
}): Promise<{ snap: CurveSnapshot; quotes: ReturnType<typeof quoteBuySequence> }> {
  const first = input.recipients[0];
  if (!first) throw new Error("No buyer wallets");
  const snap = await readCurveSnapshot(input.publicClient, input.curve, first);
  return { snap, quotes: quoteBuySequence(input.amounts, { ...snap, snipeBps: 0n }) };
}

export async function sendCurveBuys(input: {
  publicClient: PublicClient;
  rpcUrl: string;
  chain: Chain;
  curve: Address;
  wallets: StoredWallet[];
  amounts: bigint[];
  slippageBps: bigint;
}): Promise<Array<{ address: Address; hash?: Hex; tokensOut?: bigint; error?: string }>> {
  const native = await input.publicClient.readContract({
    address: input.curve,
    abi: curveAbi,
    functionName: "isNativeQuote",
  });
  const { quotes } = await quoteWalletBuys({
    publicClient: input.publicClient,
    curve: input.curve,
    recipients: input.wallets.map((w) => w.address),
    amounts: input.amounts,
  });

  const signed: Array<{ address: Address; raw?: Hex; tokensOut: bigint; error?: string }> = [];
  for (const [i, wallet] of input.wallets.entries()) {
    const amount = input.amounts[i] ?? 0n;
    const quoted = quotes[i];
    if (amount === 0n || !quoted || quoted.tokensOut === 0n) {
      signed.push({ address: wallet.address, tokensOut: 0n, error: "no buy amount or zero quote" });
      continue;
    }
    const account = privateKeyToAccount(wallet.privateKey);
    const minTokensOut = applySlippage(quoted.tokensOut, input.slippageBps);
    const data = encodeFunctionData({
      abi: curveAbi,
      functionName: "buy",
      args: [amount, minTokensOut, account.address],
    });
    const value = native ? amount : 0n;
    try {
      const nonce = await input.publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      const walletClient = createWalletClient({
        account,
        chain: input.chain,
        transport: http(input.rpcUrl),
      });
      const raw = await walletClient.signTransaction({
        account,
        chain: input.chain,
        to: input.curve,
        data,
        value,
        nonce,
      });
      signed.push({ address: wallet.address, raw, tokensOut: quoted.tokensOut });
    } catch (error) {
      signed.push({ address: wallet.address, tokensOut: quoted.tokensOut, error: unwrapError(error) });
    }
  }

  const submitted: Array<{ address: Address; hash?: Hex; tokensOut: bigint; error?: string }> =
    await Promise.all(
      signed.map(async (item) => {
        if (!item.raw || item.error) {
          return { address: item.address, tokensOut: item.tokensOut, error: item.error };
        }
        try {
          const hash = await input.publicClient.sendRawTransaction({
            serializedTransaction: item.raw,
          });
          return { address: item.address, hash, tokensOut: item.tokensOut };
        } catch (error) {
          return { address: item.address, tokensOut: item.tokensOut, error: unwrapError(error) };
        }
      }),
    );

  return Promise.all(
    submitted.map(async (item) => {
      if (!item.hash || item.error) {
        return { address: item.address, hash: item.hash, error: item.error };
      }
      const receipt = await input.publicClient.waitForTransactionReceipt({ hash: item.hash });
      if (receipt.status !== "success") {
        return { address: item.address, hash: item.hash, error: "reverted" };
      }
      const buys = parseEventLogs({ abi: [curveBuyEvent], logs: receipt.logs });
      return {
        address: item.address,
        hash: item.hash,
        tokensOut: buys[0]?.args.tokensOut ?? item.tokensOut,
      };
    }),
  );
}

export async function sellPercent(input: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  curve: Address;
  token: Address;
  percentBps: bigint;
  slippageBps: bigint;
}): Promise<{ hash: Hex; tokensIn: bigint }> {
  const balance = await input.publicClient.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [input.account.address],
  });
  const tokensIn = (balance * input.percentBps) / 10_000n;
  if (tokensIn === 0n) throw new Error(`Wallet ${input.account.address} has no tokens to sell`);

  const allowance = await input.publicClient.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [input.account.address, input.curve],
  });
  if (allowance < tokensIn) {
    const approveHash = await input.walletClient.writeContract({
      account: input.account,
      chain: input.chain,
      address: input.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [input.curve, tokensIn],
    });
    await input.publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  const snap = await readCurveSnapshot(input.publicClient, input.curve, input.account.address);
  const BPS = 10_000n;
  const gross = amountOut(tokensIn, snap.tokenReserve, snap.quoteReserve);
  const quoteOut = gross - (gross * snap.feeBps) / BPS - (gross * snap.creatorTaxBps) / BPS;
  const minQuoteOut = applySlippage(quoteOut, input.slippageBps);

  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.chain,
    address: input.curve,
    abi: curveAbi,
    functionName: "sell",
    args: [tokensIn, minQuoteOut, input.account.address],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`sell reverted: ${hash}`);
  return { hash, tokensIn };
}
