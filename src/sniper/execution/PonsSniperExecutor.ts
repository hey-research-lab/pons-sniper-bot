import {
  encodeFunctionData,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { curveAbi, curveBuyEvent, erc20Abi } from "../../abi.js";
import { NATIVE_PAIR } from "../../chain.js";
import { unwrapError } from "../../tx.js";
import type { SniperConfig } from "../config.js";
import { logEvent } from "../log.js";
import type {
  ExecutionResult,
  OpportunityContext,
  PonsOpportunity,
  SniperBuyQuote,
  SniperDecision,
  SniperExecutor,
} from "../types.js";
import { NonceManager } from "./NonceManager.js";
import { ExecutionStore } from "../state/ExecutionStore.js";

export type ExecutorDeps = {
  cfg: SniperConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  nonce: NonceManager;
  store: ExecutionStore;
};

export class PonsSniperExecutor implements SniperExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(
    opportunity: PonsOpportunity,
    decision: Extract<SniperDecision, { action: "BUY" }>,
    quote: SniperBuyQuote,
    context: OpportunityContext,
  ): Promise<ExecutionResult> {
    const walletAddress = this.deps.account.address;
    const base: ExecutionResult = {
      opportunityId: opportunity.id,
      walletAddress,
      status: "PREPARED",
      amountIn: decision.amountIn,
      expectedTokensOut: quote.expectedTokensOut,
      minTokensOut: quote.minTokensOut,
      dryRun: this.deps.cfg.dryRun,
    };

    if (quote.minTokensOut === 0n) {
      return { ...base, status: "FAILED", error: "Refusing buy without minTokensOut protection" };
    }

    const data = encodeFunctionData({
      abi: curveAbi,
      functionName: "buy",
      args: [decision.amountIn, quote.minTokensOut, walletAddress],
    });
    const value = context.nativeQuote ? decision.amountIn : 0n;

    this.deps.store.transition(opportunity.id, "TX_PREPARED", {
      amountIn: decision.amountIn.toString(),
      minTokensOut: quote.minTokensOut.toString(),
      expectedTokensOut: quote.expectedTokensOut.toString(),
      dryRun: this.deps.cfg.dryRun,
    });

    try {
      await this.ensurePairAllowance(context, decision.amountIn);
      await this.deps.publicClient.call({
        account: walletAddress,
        to: opportunity.curveAddress,
        data,
        value,
      });
    } catch (error) {
      const message = unwrapError(error);
      this.deps.store.transition(opportunity.id, "FAILED", {
        error: message,
        failureClass: "TX_REVERT",
      });
      return { ...base, status: "FAILED", error: message, failureClass: "TX_REVERT" };
    }

    if (this.deps.cfg.dryRun) {
      logEvent("sniper.execution.dry_run", {
        opportunityId: opportunity.id,
        token: opportunity.tokenAddress,
        amountIn: decision.amountIn.toString(),
        expectedTokensOut: quote.expectedTokensOut.toString(),
        minTokensOut: quote.minTokensOut.toString(),
      });
      this.deps.store.transition(opportunity.id, "SKIPPED", { error: "dry-run" });
      return { ...base, status: "PREPARED" };
    }

    let nonce: number;
    try {
      nonce = await this.deps.nonce.allocate(walletAddress);
    } catch (error) {
      const message = unwrapError(error);
      this.deps.store.transition(opportunity.id, "FAILED", {
        error: message,
        failureClass: "TRANSIENT_RPC",
      });
      return { ...base, status: "FAILED", error: message, failureClass: "TRANSIENT_RPC" };
    }

    this.deps.store.transition(opportunity.id, "SIGNED", { nonce });

    let hash: Hex;
    try {
      hash = await this.deps.walletClient.sendTransaction({
        account: this.deps.account,
        chain: this.deps.chain,
        to: opportunity.curveAddress,
        data,
        value,
        nonce,
      });
    } catch (error) {
      const message = unwrapError(error);
      this.deps.store.transition(opportunity.id, "UNKNOWN", {
        nonce,
        error: message,
        failureClass: "TRANSIENT_RPC",
      });
      logEvent("sniper.transaction.unknown", {
        opportunityId: opportunity.id,
        nonce,
        error: message,
      });
      return { ...base, status: "FAILED", error: message, failureClass: "TRANSIENT_RPC" };
    }

    this.deps.store.transition(opportunity.id, "SUBMITTED", { txHash: hash });
    logEvent("sniper.transaction.submitted", {
      opportunityId: opportunity.id,
      txHash: hash,
      token: opportunity.tokenAddress,
    });

    return this.monitor(opportunity.id, hash, base);
  }

  async monitor(opportunityId: string, hash: Hex, base: ExecutionResult): Promise<ExecutionResult> {
    this.deps.store.transition(opportunityId, "PENDING", { txHash: hash });
    try {
      const receipt = await this.deps.publicClient.waitForTransactionReceipt({
        hash,
        timeout: this.deps.cfg.receiptTimeoutMs,
      });
      return this.fromReceipt(opportunityId, hash, receipt, base);
    } catch (error) {
      const message = unwrapError(error);
      this.deps.store.transition(opportunityId, "UNKNOWN", {
        txHash: hash,
        error: message,
        failureClass: "TRANSIENT_RPC",
      });
      logEvent("sniper.transaction.unknown", { opportunityId, txHash: hash, error: message });
      return { ...base, txHash: hash, status: "FAILED", error: message, failureClass: "TRANSIENT_RPC" };
    }
  }

  fromReceipt(
    opportunityId: string,
    hash: Hex,
    receipt: TransactionReceipt,
    base: ExecutionResult,
  ): ExecutionResult {
    if (receipt.status !== "success") {
      this.deps.store.transition(opportunityId, "REVERTED", {
        txHash: hash,
        error: "reverted",
        failureClass: "TX_REVERT",
      });
      logEvent("sniper.transaction.reverted", { opportunityId, txHash: hash });
      return { ...base, txHash: hash, status: "REVERTED", error: "reverted", failureClass: "TX_REVERT" };
    }
    const buys = parseEventLogs({ abi: [curveBuyEvent], logs: receipt.logs });
    const actual = buys[0]?.args.tokensOut;
    this.deps.store.transition(opportunityId, "CONFIRMED", { txHash: hash });
    logEvent("sniper.transaction.confirmed", {
      opportunityId,
      txHash: hash,
      gasUsed: receipt.gasUsed.toString(),
      tokensOut: actual?.toString(),
    });
    return {
      ...base,
      txHash: hash,
      status: "CONFIRMED",
      actualTokensOut: actual,
    };
  }

  private async ensurePairAllowance(context: OpportunityContext, amountIn: bigint): Promise<void> {
    if (context.nativeQuote) return;
    const pair = context.launched.pairToken;
    if (pair === NATIVE_PAIR) return;
    if (this.deps.cfg.dryRun) return;
    const owner = this.deps.account.address;
    const spender = context.launched.curve;
    const allowance = await this.deps.publicClient.readContract({
      address: pair,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (allowance >= amountIn) return;
    const hash = await this.deps.walletClient.writeContract({
      account: this.deps.account,
      chain: this.deps.chain,
      address: pair,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amountIn],
    });
    const receipt = await this.deps.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`pair token approve reverted: ${hash}`);
    }
  }
}

export function classifySendFailure(message: string): "TRANSIENT_RPC" | "TX_REVERT" | "INSUFFICIENT_FUNDS" {
  const lower = message.toLowerCase();
  if (lower.includes("insufficient funds") || lower.includes("insufficient_funds")) return "INSUFFICIENT_FUNDS";
  if (lower.includes("slippage") || lower.includes("reverted") || lower.includes("curvegraduated")) return "TX_REVERT";
  return "TRANSIENT_RPC";
}

export type PreparedBuy = {
  to: Address;
  data: Hex;
  value: bigint;
};
