import { join } from "node:path";
import type { Account, Chain, PublicClient, WalletClient } from "viem";
import { erc20Abi } from "../abi.js";
import { fmtEth, fmtUnits } from "../format.js";
import type { SniperConfig } from "./config.js";
import { PonsSniperExecutor } from "./execution/PonsSniperExecutor.js";
import { logEvent } from "./log.js";
import { MetricsStore } from "./metrics.js";
import { PositionManager } from "./position/PositionManager.js";
import { loadOpportunityContext } from "./protocolContext.js";
import { PonsQuoteEngine } from "./quote/PonsQuoteEngine.js";
import { SniperReconciler } from "./reconciliation/SniperReconciler.js";
import { SniperRiskEngine } from "./risk/SniperRiskEngine.js";
import { CooldownStore } from "./state/CooldownStore.js";
import { ExecutionStore } from "./state/ExecutionStore.js";
import { OpportunityRegistry } from "./state/OpportunityRegistry.js";
import { PonsSniperStrategy } from "./strategy/PonsSniperStrategy.js";
import type { PonsOpportunity, SniperBuyQuote } from "./types.js";
import type { SniperWallet } from "./wallet.js";

export type PipelineDeps = {
  cfg: SniperConfig;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  chain: Chain;
  wallet: SniperWallet;
  registry: OpportunityRegistry;
  executions: ExecutionStore;
  positions: PositionManager;
  strategy: PonsSniperStrategy;
  risk: SniperRiskEngine;
  quotes: PonsQuoteEngine;
  executor: PonsSniperExecutor;
  reconciler: SniperReconciler;
  metrics: MetricsStore;
  cooldowns: CooldownStore;
};

const inFlight = new Set<string>();

export async function handleOpportunity(deps: PipelineDeps, opportunity: PonsOpportunity): Promise<void> {
  if (inFlight.has(opportunity.id)) return;
  const duplicate = deps.executions.shouldSkipDuplicate(opportunity.id);
  if (duplicate) {
    logEvent("sniper.opportunity.duplicate", {
      opportunityId: opportunity.id,
      existingState: duplicate.state,
    });
    return;
  }
  deps.metrics.increment("opportunitiesDetected");
  if (!deps.registry.has(opportunity.id)) {
    deps.registry.add(opportunity);
  }
  inFlight.add(opportunity.id);
  try {
    await runPipeline(deps, opportunity);
  } finally {
    inFlight.delete(opportunity.id);
  }
}

async function runPipeline(deps: PipelineDeps, opportunity: PonsOpportunity): Promise<void> {
  if (!deps.executions.get(opportunity.id)) {
    deps.executions.upsert({
      opportunityId: opportunity.id,
      tokenAddress: opportunity.tokenAddress,
      curveAddress: opportunity.curveAddress,
      walletAddress: deps.wallet.address,
      state: "DETECTED",
      dryRun: deps.cfg.dryRun,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  let context;
  try {
    context = await loadOpportunityContext(
      deps.publicClient,
      deps.cfg.factory,
      opportunity,
      deps.wallet.address,
    );
  } catch (error) {
    deps.metrics.increment("rpcFailures");
    logEvent("sniper.pipeline.context_failed", {
      opportunityId: opportunity.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  opportunity.metadata = {
    ...opportunity.metadata,
    name: context.tokenMeta?.name,
    symbol: context.tokenMeta?.symbol,
  };
  opportunity.initialLiquidity = context.realQuoteReserve;
  opportunity.pairToken = context.launched.pairToken;
  opportunity.creator = opportunity.creator ?? context.launched.deployer;
  opportunity.curveAddress = context.launched.curve;
  deps.registry.add(opportunity);
  deps.executions.transition(opportunity.id, "VALIDATED");

  const retryDeadline = opportunity.detectedAt + deps.cfg.snipeTaxRetryWindowMs;
  let decision = await deps.strategy.evaluate(opportunity, context);

  while (decision.action === "SKIP" && decision.retryable && Date.now() < retryDeadline) {
    logEvent("sniper.signal", {
      opportunityId: opportunity.id,
      action: "SKIP",
      reason: decision.reason,
      retryable: true,
    });
    await sleep(decision.retryAfterMs ?? deps.cfg.snipeTaxRetryMs);
    context = await loadOpportunityContext(
      deps.publicClient,
      deps.cfg.factory,
      opportunity,
      deps.wallet.address,
    );
    decision = await deps.strategy.evaluate(opportunity, context);
  }

  logEvent("sniper.signal", {
    opportunityId: opportunity.id,
    action: decision.action,
    reason: decision.reason,
    amountIn: decision.action === "BUY" ? decision.amountIn.toString() : undefined,
  });

  if (decision.action === "SKIP") {
    deps.metrics.increment("opportunitiesSkipped");
    deps.executions.transition(opportunity.id, "SKIPPED", {
      error: decision.reason,
      failureClass: decision.failureClass,
    });
    if (!decision.retryable) deps.cooldowns.markSkip();
    return;
  }

  deps.metrics.increment("buySignals");
  const quote = deps.quotes.quoteBuy(decision.amountIn, context.snapshot, decision.maxSlippageBps);
  deps.executions.transition(opportunity.id, "QUOTED", {
    amountIn: decision.amountIn.toString(),
    expectedTokensOut: quote.expectedTokensOut.toString(),
    minTokensOut: quote.minTokensOut.toString(),
  });

  const [nativeBalance, gasPrice] = await Promise.all([
    deps.publicClient.getBalance({ address: deps.wallet.address }),
    deps.publicClient.getGasPrice(),
  ]);
  const estimatedGasCost = 250_000n * gasPrice;
  const cooldown = deps.cooldowns.read();
  const risk = deps.risk.validate({
    opportunity,
    amountIn: decision.amountIn,
    maxSlippageBps: decision.maxSlippageBps,
    walletAddress: deps.wallet.address,
    nativeBalance,
    estimatedGasCost,
    quote,
    context,
    openPositions: deps.positions.openPositions(),
    entriesLastHour: deps.positions.entriesSince(Date.now() - 3_600_000).length,
    lastSkipAt: cooldown.lastSkipAt,
    lastExecutionAt: cooldown.lastExecutionAt,
  });

  if (!risk.approved) {
    deps.metrics.increment("riskRejections");
    deps.metrics.increment("opportunitiesSkipped");
    deps.executions.transition(opportunity.id, "SKIPPED", {
      error: risk.reason,
      failureClass: risk.failureClass ?? "RISK_REJECTED",
    });
    deps.cooldowns.markSkip();
    logEvent("sniper.risk.rejected", {
      opportunityId: opportunity.id,
      reason: risk.reason,
    });
    return;
  }

  deps.executions.transition(opportunity.id, "RISK_APPROVED");
  printHumanSummary(opportunity, decision, quote, true, deps.cfg.dryRun);

  const result = await deps.executor.execute(opportunity, decision, quote, context);
  if (result.status === "SUBMITTED" || result.status === "CONFIRMED") {
    deps.metrics.increment("transactionsSubmitted");
    deps.metrics.recordLatency(Date.now() - opportunity.detectedAt);
  }
  if (result.status === "CONFIRMED" && result.txHash) {
    deps.metrics.increment("transactionsConfirmed");
    deps.cooldowns.markExecution();
    const onchain = await deps.publicClient.readContract({
      address: opportunity.tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [deps.wallet.address],
    });
    deps.positions.open({
      opportunityId: opportunity.id,
      tokenAddress: opportunity.tokenAddress,
      curveAddress: opportunity.curveAddress,
      walletAddress: deps.wallet.address,
      amountBought: onchain,
      entryAmount: decision.amountIn,
      entryTxHash: result.txHash,
    });
    deps.metrics.setOpenPositions(deps.positions.openPositions().length);
  }
  if (result.status === "REVERTED") {
    deps.metrics.increment("transactionsReverted");
    deps.cooldowns.markExecution();
  }
  if (result.failureClass === "TRANSIENT_RPC") {
    deps.metrics.increment("rpcFailures");
  }
}

function printHumanSummary(
  opportunity: PonsOpportunity,
  decision: { action: "BUY"; amountIn: bigint },
  quote: Pick<SniperBuyQuote, "expectedTokensOut" | "minTokensOut">,
  riskApproved: boolean,
  dryRun: boolean,
): void {
  console.log("PONS SNIPER");
  console.log("────────────────────────────");
  console.log("Opportunity detected");
  console.log(`Token: ${opportunity.tokenAddress}`);
  if (opportunity.metadata?.symbol) console.log(`Symbol: ${opportunity.metadata.symbol}`);
  console.log(`Signal: ${decision.action}`);
  console.log(`Amount: ${fmtEth(decision.amountIn)}`);
  console.log(`Expected output: ${fmtUnits(quote.expectedTokensOut)}`);
  console.log(`Minimum output: ${fmtUnits(quote.minTokensOut)}`);
  console.log(`Risk: ${riskApproved ? "APPROVED" : "REJECTED"}`);
  if (dryRun) {
    console.log("Execution: DRY RUN");
    console.log("No transaction broadcast");
  }
  console.log("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createStores(cfg: SniperConfig, publicClient: PublicClient, walletAddress: `0x${string}`) {
  const registry = new OpportunityRegistry(join(cfg.dataDir, "opportunities.json"));
  const executions = new ExecutionStore(join(cfg.dataDir, "executions.json"));
  const positions = new PositionManager(join(cfg.dataDir, "positions.json"), publicClient);
  const metrics = new MetricsStore(join(cfg.dataDir, "metrics.json"));
  const cooldowns = new CooldownStore(join(cfg.dataDir, "cooldowns.json"));
  const reconciler = new SniperReconciler(publicClient, executions, positions, walletAddress);
  return { registry, executions, positions, metrics, cooldowns, reconciler };
}
