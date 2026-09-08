import { getAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../chain.js";
import { NATIVE_PAIR } from "../chain.js";
import type { PonsOpportunity } from "./types.js";

export function opportunityId(input: {
  chainId?: number;
  factory: Address;
  token: Address;
}): string {
  return `${input.chainId ?? ROBINHOOD_CHAIN_ID}:${getAddress(input.factory)}:${getAddress(input.token)}`;
}

export function opportunityFromLaunch(input: {
  factory: Address;
  token: Address;
  curve: Address;
  deployer: Address;
  pairToken?: Address;
  launchConfigId?: bigint;
  graduationThreshold?: bigint;
  transactionHash?: Hex;
  blockNumber?: bigint;
  logIndex?: number;
}): PonsOpportunity {
  const token = getAddress(input.token);
  return {
    id: opportunityId({ factory: input.factory, token }),
    tokenAddress: token,
    curveAddress: getAddress(input.curve),
    detectedAt: Date.now(),
    creator: getAddress(input.deployer),
    launchTxHash: input.transactionHash,
    pairToken: getAddress(input.pairToken ?? NATIVE_PAIR),
    launchConfigId: input.launchConfigId,
    graduationThreshold: input.graduationThreshold,
    rawEvent: {
      blockNumber: input.blockNumber?.toString(),
      logIndex: input.logIndex,
      transactionHash: input.transactionHash,
    },
  };
}
