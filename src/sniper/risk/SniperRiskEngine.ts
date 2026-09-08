import { getAddress, type Address } from "viem";
import type { SniperConfig } from "../config.js";
import type { Position } from "../types.js";
import type { OpportunityContext, PonsOpportunity, RiskCheck, SniperBuyQuote } from "../types.js";

export type RiskInput = {
  opportunity: PonsOpportunity;
  amountIn: bigint;
  maxSlippageBps: number;
  walletAddress: Address;
  nativeBalance: bigint;
  estimatedGasCost: bigint;
  quote: SniperBuyQuote;
  context: OpportunityContext;
  openPositions: Position[];
  entriesLastHour: number;
  lastSkipAt?: number;
  lastExecutionAt?: number;
  now?: number;
};

export class SniperRiskEngine {
  constructor(private readonly cfg: SniperConfig) {}

  validate(input: RiskInput): RiskCheck {
    const now = input.now ?? Date.now();
    if (input.amountIn <= 0n) {
      return { approved: false, reason: "Position size is zero", failureClass: "RISK_REJECTED" };
    }
    if (input.amountIn > this.cfg.maxPositionSize) {
      return { approved: false, reason: "Amount exceeds max position size", failureClass: "RISK_REJECTED" };
    }
    if (input.maxSlippageBps > this.cfg.maxSlippageBps) {
      return { approved: false, reason: "Slippage exceeds configured maximum", failureClass: "RISK_REJECTED" };
    }
    if (input.quote.minTokensOut === 0n) {
      return { approved: false, reason: "minTokensOut is zero; refusing unprotected buy", failureClass: "RISK_REJECTED" };
    }
    if (input.quote.expectedTokensOut === 0n) {
      return { approved: false, reason: "Quote returned zero tokens", failureClass: "STALE_QUOTE" };
    }

    const required = input.amountIn + this.cfg.gasReserve + input.estimatedGasCost;
    if (input.nativeBalance < required) {
      return {
        approved: false,
        reason: "Insufficient native balance for buy + gas reserve",
        failureClass: "INSUFFICIENT_FUNDS",
      };
    }
    if (input.nativeBalance - input.amountIn < this.cfg.gasReserve) {
      return { approved: false, reason: "Buy would consume the gas reserve", failureClass: "INSUFFICIENT_FUNDS" };
    }

    const open = input.openPositions.filter((p) => p.status === "OPEN" || p.status === "UNKNOWN");
    if (open.length >= this.cfg.maxPositions) {
      return { approved: false, reason: "Maximum open positions reached", failureClass: "RISK_REJECTED" };
    }
    const token = getAddress(input.opportunity.tokenAddress);
    if (
      this.cfg.onePositionPerToken &&
      open.some((p) => getAddress(p.tokenAddress) === token && getAddress(p.walletAddress) === getAddress(input.walletAddress))
    ) {
      return { approved: false, reason: "Position already open for this token", failureClass: "RISK_REJECTED" };
    }

    const exposure = open.reduce((sum, p) => sum + p.entryAmount, 0n) + input.amountIn;
    if (exposure > this.cfg.maxExposure) {
      return { approved: false, reason: "Maximum portfolio exposure exceeded", failureClass: "RISK_REJECTED" };
    }
    const tokenExposure =
      open.filter((p) => getAddress(p.tokenAddress) === token).reduce((sum, p) => sum + p.entryAmount, 0n) +
      input.amountIn;
    if (tokenExposure > this.cfg.maxTokenExposure) {
      return { approved: false, reason: "Maximum token exposure exceeded", failureClass: "RISK_REJECTED" };
    }

    if (input.entriesLastHour >= this.cfg.maxEntriesPerHour) {
      return { approved: false, reason: "Maximum entries per hour exceeded", failureClass: "RISK_REJECTED" };
    }
    if (input.lastSkipAt !== undefined && now - input.lastSkipAt < this.cfg.cooldownMs) {
      return { approved: false, reason: "Cooldown after rejected signal", failureClass: "RISK_REJECTED" };
    }
    if (input.lastExecutionAt !== undefined && now - input.lastExecutionAt < this.cfg.executionCooldownMs) {
      return { approved: false, reason: "Cooldown after execution", failureClass: "RISK_REJECTED" };
    }

    if (!input.context.launched.exists || input.context.launched.phase !== 0) {
      return { approved: false, reason: "Protocol state is not a live curve", failureClass: "RISK_REJECTED" };
    }
    if (input.context.graduated || input.context.readyToGraduate) {
      return { approved: false, reason: "Curve no longer accepts sniper buys", failureClass: "STALE_QUOTE" };
    }

    return { approved: true };
  }
}
