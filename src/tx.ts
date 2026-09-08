import {
  BaseError,
  decodeErrorResult,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { curveAbi, factoryAbi, routerAbi } from "./abi.js";
import { ROBINHOOD_CHAIN_ID } from "./chain.js";

const ERROR_ABIS = [factoryAbi, routerAbi, curveAbi] as const;

export function unwrapError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => "data" in (e as object));
    const data = (revert as { data?: Hex } | undefined)?.data;
    if (data && data !== "0x") {
      for (const abi of ERROR_ABIS) {
        try {
          const decoded = decodeErrorResult({ abi: abi as Abi, data });
          return decoded.errorName;
        } catch {
          // try next abi
        }
      }
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function assertRobinhood(client: PublicClient): Promise<void> {
  const id = await client.getChainId();
  if (id !== ROBINHOOD_CHAIN_ID) {
    throw new Error(`Wrong chain ${id}; expected Robinhood Chain ${ROBINHOOD_CHAIN_ID}`);
  }
}

export async function sendAndWait(input: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  to: Address;
  data: Hex;
  value?: bigint;
  gas?: bigint;
  nonce?: number;
}): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  const hash = await input.walletClient.sendTransaction({
    account: input.account,
    chain: input.chain,
    to: input.to,
    data: input.data,
    value: input.value ?? 0n,
    gas: input.gas,
    nonce: input.nonce,
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return { hash, receipt };
}
