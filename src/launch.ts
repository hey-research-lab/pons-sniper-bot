import {
  encodeFunctionData,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { curveBuyEvent, factoryAbi, routerAbi, tokenLaunchedEvent } from "./abi.js";
import { MAX_EXEMPTIONS, NATIVE_PAIR } from "./chain.js";
import { applyBuy, applySlippage, quoteBuy, quoteBuySequence } from "./quote.js";
import {
  assertPairUsable,
  readLaunchConfig,
  snapshotFromLaunchConfig,
  tokenParams,
  type TokenParamsInput,
} from "./protocol.js";
import { unwrapError } from "./tx.js";

export type LaunchPlan = {
  name: string;
  symbol: string;
  logo?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
  launchConfigId: bigint;
  pairToken: Address;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  masterBuy: bigint;
  walletBuys: bigint[];
  exemptions: Address[];
  recipient: Address;
  slippageBps: bigint;
};

export type PreparedLaunch = {
  params: ReturnType<typeof tokenParams>;
  to: Address;
  data: Hex;
  value: bigint;
  launchFee: bigint;
  minTokensOut: bigint;
  masterQuote: ReturnType<typeof quoteBuy>;
  walletQuotes: ReturnType<typeof quoteBuySequence>;
};

export async function prepareLaunch(input: {
  publicClient: PublicClient;
  factory: Address;
  launchAndBuy: Address;
  account: Address;
  plan: LaunchPlan;
}): Promise<PreparedLaunch> {
  if (input.plan.exemptions.length > MAX_EXEMPTIONS) {
    throw new Error(`At most ${MAX_EXEMPTIONS} extra exemption wallets`);
  }
  if (input.plan.creatorFeeRecipient === NATIVE_PAIR) {
    throw new Error("launchAndBuy requires an explicit creatorFeeRecipient");
  }

  const [canLaunch, launchFee, maxTax, expectedEconomics, config] = await Promise.all([
    input.publicClient.readContract({
      address: input.factory,
      abi: factoryAbi,
      functionName: "canLaunch",
      args: [input.account],
    }),
    input.publicClient.readContract({
      address: input.factory,
      abi: factoryAbi,
      functionName: "launchFee",
    }),
    input.publicClient.readContract({
      address: input.factory,
      abi: factoryAbi,
      functionName: "maxCreatorTaxBps",
    }),
    input.publicClient.readContract({
      address: input.factory,
      abi: factoryAbi,
      functionName: "previewLaunchEconomics",
      args: [input.plan.launchConfigId, input.plan.pairToken],
    }),
    readLaunchConfig(input.publicClient, input.factory, input.plan.launchConfigId),
  ]);

  if (!canLaunch) {
    throw new Error(`canLaunch(${input.account}) is false — public launching may be gated`);
  }
  if (!config.enabled) {
    throw new Error(`Launch config ${input.plan.launchConfigId} is disabled`);
  }
  if (BigInt(input.plan.creatorTaxBps) > maxTax) {
    throw new Error(`creatorTaxBps ${input.plan.creatorTaxBps} exceeds cap ${maxTax}`);
  }
  await assertPairUsable(input.publicClient, input.factory, input.plan.pairToken);

  const salt = crypto.getRandomValues(new Uint8Array(32));
  const paramsInput: TokenParamsInput = {
    name: input.plan.name,
    symbol: input.plan.symbol,
    logo: input.plan.logo ?? "",
    description: input.plan.description ?? "",
    twitter: input.plan.twitter,
    telegram: input.plan.telegram,
    discord: input.plan.discord,
    website: input.plan.website,
    farcaster: input.plan.farcaster,
    creatorFeeRecipient: input.plan.creatorFeeRecipient,
    creatorTaxBps: input.plan.creatorTaxBps,
    buybackEnabled: input.plan.buybackEnabled,
    expectedEconomics,
    salt: `0x${Buffer.from(salt).toString("hex")}`,
  };
  const params = tokenParams(paramsInput);

  const start = snapshotFromLaunchConfig(config, BigInt(input.plan.creatorTaxBps), 0n);
  const masterQuote = quoteBuy(input.plan.masterBuy, start);
  const walletQuotes = quoteBuySequence(input.plan.walletBuys, applyBuy(start, masterQuote));
  const minTokensOut = applySlippage(masterQuote.tokensOut, input.plan.slippageBps);

  const native = input.plan.pairToken === NATIVE_PAIR;
  const value = native ? launchFee + input.plan.masterBuy : launchFee;
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: "launchAndBuy",
    args: [
      params,
      input.plan.launchConfigId,
      input.plan.pairToken,
      input.plan.masterBuy,
      minTokensOut,
      input.plan.recipient,
      input.plan.exemptions,
    ],
  });

  return {
    params,
    to: input.launchAndBuy,
    data,
    value,
    launchFee,
    minTokensOut,
    masterQuote,
    walletQuotes,
  };
}

export async function simulateLaunch(input: {
  publicClient: PublicClient;
  account: Address;
  prepared: PreparedLaunch;
}): Promise<void> {
  try {
    await input.publicClient.call({
      account: input.account,
      to: input.prepared.to,
      data: input.prepared.data,
      value: input.prepared.value,
    });
  } catch (error) {
    throw new Error(`launchAndBuy simulation failed: ${unwrapError(error)}`);
  }
}

export async function sendLaunch(input: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  prepared: PreparedLaunch;
}): Promise<{
  hash: Hex;
  token: Address;
  curve: Address;
  tokensOut: bigint;
  quoteIn: bigint;
}> {
  const hash = await input.walletClient.sendTransaction({
    account: input.account,
    chain: input.chain,
    to: input.prepared.to,
    data: input.prepared.data,
    value: input.prepared.value,
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`launchAndBuy reverted: ${hash}`);
  }

  const launched = parseEventLogs({
    abi: [tokenLaunchedEvent],
    logs: receipt.logs,
  });
  const buys = parseEventLogs({
    abi: [curveBuyEvent],
    logs: receipt.logs,
  });
  const launchLog = launched[0];
  if (!launchLog) {
    throw new Error("TokenLaunched event missing from receipt");
  }

  return {
    hash,
    token: launchLog.args.token,
    curve: launchLog.args.curve,
    tokensOut: buys[0]?.args.tokensOut ?? 0n,
    quoteIn: buys[0]?.args.quoteIn ?? input.prepared.masterQuote.spent,
  };
}
