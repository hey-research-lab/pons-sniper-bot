import { getAddress } from "viem";
import { NATIVE_PAIR } from "../../chain.js";
import { defaultPairAllowlist, type SniperConfig } from "../config.js";
import type { OpportunityContext, PonsOpportunity, SniperDecision, TradingStrategy } from "../types.js";

export type { TradingStrategy } from "../types.js";

export class PonsSniperStrategy implements TradingStrategy {
  constructor(private readonly cfg: SniperConfig) {}

  async evaluate(opportunity: PonsOpportunity, context: OpportunityContext): Promise<SniperDecision> {
    if (!context.launched.exists) {
      return { action: "SKIP", reason: "Token is not a Pons v2 launch on this factory" };
    }
    if (context.launched.phase !== 0) {
      return { action: "SKIP", reason: `Launch phase ${context.launched.phase} is not curve-tradable` };
    }
    if (context.graduated || context.readyToGraduate) {
      return { action: "SKIP", reason: "Curve is graduating or already graduated" };
    }
    if (context.snapshot.sellable === 0n) {
      return { action: "SKIP", reason: "No sellable tokens remaining on the curve" };
    }

    const pair = getAddress(opportunity.pairToken ?? context.launched.pairToken);
    const allowedPairs = defaultPairAllowlist(this.cfg);
    if (allowedPairs.length > 0 && !allowedPairs.some((item) => getAddress(item) === pair)) {
      return { action: "SKIP", reason: `Pair token ${pair} is not in the allowlist` };
    }
    if (this.cfg.nativeQuoteOnly && pair !== NATIVE_PAIR) {
      return { action: "SKIP", reason: "Non-native quote launches are disabled" };
    }

    const creator = getAddress(opportunity.creator ?? context.launched.deployer);
    if (this.cfg.creatorDenylist.some((item) => getAddress(item) === creator)) {
      return { action: "SKIP", reason: "Creator is denylisted" };
    }
    if (
      this.cfg.creatorAllowlist.length > 0 &&
      !this.cfg.creatorAllowlist.some((item) => getAddress(item) === creator)
    ) {
      return { action: "SKIP", reason: "Creator is not on the allowlist" };
    }

    const symbol = (opportunity.metadata?.symbol ?? context.tokenMeta?.symbol ?? "").toUpperCase();
    if (symbol && this.cfg.symbolDenylist.includes(symbol)) {
      return { action: "SKIP", reason: `Symbol ${symbol} is denylisted` };
    }
    if (this.cfg.symbolAllowlist.length > 0 && !this.cfg.symbolAllowlist.includes(symbol)) {
      return { action: "SKIP", reason: `Symbol ${symbol || "(unknown)"} is not on the allowlist` };
    }

    if (context.realQuoteReserve < this.cfg.minRealQuote) {
      return { action: "SKIP", reason: "Real quote reserve below minimum" };
    }
    if (this.cfg.maxRealQuote !== undefined && context.realQuoteReserve > this.cfg.maxRealQuote) {
      return { action: "SKIP", reason: "Real quote reserve above maximum" };
    }

    if (context.snapshot.creatorTaxBps > BigInt(this.cfg.maxCreatorTaxBps)) {
      return { action: "SKIP", reason: `Creator tax ${context.snapshot.creatorTaxBps} bps exceeds max` };
    }

    if (context.snapshot.snipeBps > BigInt(this.cfg.maxSnipeTaxBps)) {
      return {
        action: "SKIP",
        reason: `Snipe tax ${context.snapshot.snipeBps} bps exceeds max ${this.cfg.maxSnipeTaxBps}`,
        retryable: true,
        retryAfterMs: this.cfg.snipeTaxRetryMs,
        failureClass: "STALE_QUOTE",
      };
    }

    if (this.cfg.buyAmount <= 0n) {
      return { action: "SKIP", reason: "Configured buy amount is zero" };
    }
    if (this.cfg.maxSlippageBps < 0 || this.cfg.maxSlippageBps >= 10_000) {
      return { action: "SKIP", reason: "Configured slippage is out of bounds" };
    }

    return {
      action: "BUY",
      reason: "Passed configured launch filters",
      amountIn: this.cfg.buyAmount,
      maxSlippageBps: this.cfg.maxSlippageBps,
    };
  }
}
