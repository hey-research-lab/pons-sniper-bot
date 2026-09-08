import type { Address, PublicClient } from "viem";
import { curveAbi } from "../abi.js";
import { NATIVE_PAIR, ROBINHOOD_CHAIN_ID } from "../chain.js";
import { readErc20Meta, readLaunchedToken } from "../protocol.js";
import { readCurveSnapshot } from "../protocol.js";
import { logEvent } from "./log.js";
import type { OpportunityContext, PonsOpportunity } from "./types.js";

export async function checkRpcHealth(client: PublicClient): Promise<{ chainId: number; blockNumber: bigint }> {
  const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(`Wrong chain ${chainId}; expected Robinhood Chain ${ROBINHOOD_CHAIN_ID}`);
  }
  return { chainId, blockNumber };
}

export async function loadOpportunityContext(
  client: PublicClient,
  factory: Address,
  opportunity: PonsOpportunity,
  recipient: Address,
): Promise<OpportunityContext> {
  const launched = await readLaunchedToken(client, factory, opportunity.tokenAddress);
  if (!launched.exists) {
    throw new Error(`getLaunchedToken(${opportunity.tokenAddress}) does not exist`);
  }
  const curve = launched.curve;
  const [snapshot, nativeQuote, realQuoteReserve, graduated, readyToGraduate, tokenMeta] = await Promise.all([
    readCurveSnapshot(client, curve, recipient),
    client.readContract({ address: curve, abi: curveAbi, functionName: "isNativeQuote" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "realQuoteReserve" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "graduated" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "readyToGraduate" }),
    readErc20Meta(client, opportunity.tokenAddress).catch((error) => {
      logEvent("sniper.token.meta_unreadable", {
        token: opportunity.tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }),
  ]);

  return {
    launched,
    snapshot,
    nativeQuote,
    realQuoteReserve,
    graduated,
    readyToGraduate,
    tokenMeta,
  };
}

export { NATIVE_PAIR };
