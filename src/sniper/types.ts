import type { Address, Hex } from "viem";
import type { CurveSnapshot } from "../quote.js";
import type { LaunchedToken } from "../protocol.js";

export type DetectionMode = "event" | "polling";

export type FailureClass =
  | "TRANSIENT_RPC"
  | "TX_REVERT"
  | "RISK_REJECTED"
  | "INSUFFICIENT_FUNDS"
  | "STALE_QUOTE"
  | "UNKNOWN";

export type TxLifecycleState =
  | "DETECTED"
  | "VALIDATED"
  | "QUOTED"
  | "RISK_APPROVED"
  | "TX_PREPARED"
  | "SIGNED"
  | "SUBMITTED"
  | "PENDING"
  | "CONFIRMED"
  | "REVERTED"
  | "UNKNOWN"
  | "SKIPPED"
  | "FAILED";

export interface PonsOpportunity {
  id: string;
  tokenAddress: Address;
  curveAddress: Address;
  detectedAt: number;
  creator?: Address;
  launchTxHash?: Hex;
  pairToken?: Address;
  launchConfigId?: bigint;
  graduationThreshold?: bigint;
  initialLiquidity?: bigint;
  metadata?: {
    name?: string;
    symbol?: string;
    uri?: string;
  };
  rawEvent?: unknown;
}

export type SniperDecision =
  | {
      action: "SKIP";
      reason: string;
      retryable?: boolean;
      retryAfterMs?: number;
      failureClass?: FailureClass;
    }
  | {
      action: "BUY";
      reason: string;
      amountIn: bigint;
      maxSlippageBps: number;
    };

export interface TradingStrategy {
  evaluate(opportunity: PonsOpportunity, context: OpportunityContext): Promise<SniperDecision>;
}

export type OpportunityContext = {
  launched: LaunchedToken;
  snapshot: CurveSnapshot;
  nativeQuote: boolean;
  realQuoteReserve: bigint;
  graduated: boolean;
  readyToGraduate: boolean;
  tokenMeta?: { name: string; symbol: string; decimals: number };
};

export interface SniperBuyQuote {
  amountIn: bigint;
  expectedTokensOut: bigint;
  minTokensOut: bigint;
  spent: bigint;
  refund: bigint;
  fee: bigint;
  tax: bigint;
  snipeTax: bigint;
  snipeBps: bigint;
  priceImpactBps?: number;
}

export interface RiskCheck {
  approved: boolean;
  reason?: string;
  failureClass?: FailureClass;
}

export type ExecutionStatus = "PREPARED" | "SUBMITTED" | "CONFIRMED" | "REVERTED" | "FAILED";

export interface ExecutionResult {
  opportunityId: string;
  walletAddress: Address;
  txHash?: Hex;
  status: ExecutionStatus;
  amountIn: bigint;
  expectedTokensOut?: bigint;
  minTokensOut?: bigint;
  actualTokensOut?: bigint;
  error?: string;
  failureClass?: FailureClass;
  dryRun: boolean;
}

export interface SniperExecutor {
  execute(
    opportunity: PonsOpportunity,
    decision: Extract<SniperDecision, { action: "BUY" }>,
    quote: SniperBuyQuote,
    context: OpportunityContext,
  ): Promise<ExecutionResult>;
}

export type PositionStatus = "OPEN" | "CLOSING" | "CLOSED" | "UNKNOWN";

export interface Position {
  id: string;
  opportunityId: string;
  tokenAddress: Address;
  curveAddress: Address;
  walletAddress: Address;
  amountBought: bigint;
  entryAmount: bigint;
  entryTxHash: Hex;
  openedAt: number;
  status: PositionStatus;
}

export interface ExecutionRecord {
  opportunityId: string;
  tokenAddress: Address;
  curveAddress: Address;
  walletAddress: Address;
  state: TxLifecycleState;
  amountIn?: string;
  minTokensOut?: string;
  expectedTokensOut?: string;
  txHash?: Hex;
  nonce?: number;
  dryRun: boolean;
  error?: string;
  failureClass?: FailureClass;
  updatedAt: number;
  createdAt: number;
}

export interface PonsOpportunityDetector {
  start(): Promise<void>;
  stop(): Promise<void>;
}
