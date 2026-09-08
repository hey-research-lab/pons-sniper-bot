import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, parseEther, zeroAddress } from "viem";
import { ADDRESSES } from "../chain.js";
import { applySlippage, quoteBuy, snapshotFromConfig } from "../quote.js";
import { opportunityId, opportunityFromLaunch } from "./ids.js";
import { logEvent } from "./log.js";
import { PonsQuoteEngine } from "./quote/PonsQuoteEngine.js";
import { SniperRiskEngine, type RiskInput } from "./risk/SniperRiskEngine.js";
import { ExecutionStore, isInFlightState, isTerminalState } from "./state/ExecutionStore.js";
import { OpportunityRegistry } from "./state/OpportunityRegistry.js";
import { PositionManager } from "./position/PositionManager.js";
import { PonsSniperStrategy } from "./strategy/PonsSniperStrategy.js";
import type { OpportunityContext, PonsOpportunity, Position, SniperBuyQuote } from "./types.js";
import type { SniperConfig } from "./config.js";
import type { LaunchedToken } from "../protocol.js";

const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const CURVE = getAddress("0x2222222222222222222222222222222222222222");
const CREATOR = getAddress("0x3333333333333333333333333333333333333333");
const WALLET = getAddress("0x4444444444444444444444444444444444444444");
const OTHER = getAddress("0x5555555555555555555555555555555555555555");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pons-sniper-"));
}

function opportunity(overrides: Partial<PonsOpportunity> = {}): PonsOpportunity {
  return {
    id: opportunityId({ factory: ADDRESSES.factory, token: TOKEN }),
    tokenAddress: TOKEN,
    curveAddress: CURVE,
    detectedAt: Date.now(),
    creator: CREATOR,
    pairToken: zeroAddress,
    launchConfigId: 0n,
    graduationThreshold: parseEther("4.2"),
    ...overrides,
  };
}

function launched(overrides: Partial<LaunchedToken> = {}): LaunchedToken {
  return {
    token: TOKEN,
    curve: CURVE,
    deployer: CREATOR,
    creatorFeeRecipient: CREATOR,
    pairToken: zeroAddress,
    graduationThreshold: parseEther("4.2"),
    poolFee: 0,
    tickSpacing: 0,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: true,
    ...overrides,
  };
}

function context(overrides: Partial<OpportunityContext> = {}): OpportunityContext {
  const supply = 1_000_000_000n * 10n ** 18n;
  return {
    launched: launched(),
    snapshot: snapshotFromConfig({
      supply,
      phantomQuote: parseEther("1.67"),
      threshold: parseEther("4.2"),
      feeBps: 100n,
      creatorTaxBps: 0n,
      snipeBps: 0n,
    }),
    nativeQuote: true,
    realQuoteReserve: parseEther("0.1"),
    graduated: false,
    readyToGraduate: false,
    tokenMeta: { name: "Example", symbol: "EXMPL", decimals: 18 },
    ...overrides,
  };
}

function cfg(overrides: Partial<SniperConfig> = {}): SniperConfig {
  return {
    rpcUrl: "http://127.0.0.1:8545",
    rpcTimeoutMs: 15_000,
    rpcRetries: 0,
    factory: ADDRESSES.factory,
    launchAndBuy: ADDRESSES.launchAndBuy,
    enabled: true,
    dryRun: true,
    detectionMode: "polling",
    pollIntervalMs: 2_000,
    pollLookbackBlocks: 4,
    dataDir: tmp(),
    buyAmount: parseEther("0.02"),
    maxSlippageBps: 800,
    gasReserve: parseEther("0.0004"),
    maxPositionSize: parseEther("0.05"),
    maxPositions: 5,
    maxExposure: parseEther("0.2"),
    maxTokenExposure: parseEther("0.05"),
    maxEntriesPerHour: 10,
    cooldownMs: 15_000,
    executionCooldownMs: 15_000,
    onePositionPerToken: true,
    nativeQuoteOnly: true,
    maxSnipeTaxBps: 0,
    maxCreatorTaxBps: 500,
    minRealQuote: 0n,
    creatorAllowlist: [],
    creatorDenylist: [],
    symbolAllowlist: [],
    symbolDenylist: [],
    pairAllowlist: [],
    reconcileIntervalMs: 15_000,
    receiptTimeoutMs: 60_000,
    snipeTaxRetryMs: 750,
    snipeTaxRetryWindowMs: 8_000,
    ...overrides,
  };
}

test("opportunity ids are deterministic across event and polling", () => {
  const a = opportunityFromLaunch({
    factory: ADDRESSES.factory,
    token: TOKEN,
    curve: CURVE,
    deployer: CREATOR,
    transactionHash: "0xabc",
  });
  const b = opportunityFromLaunch({
    factory: ADDRESSES.factory,
    token: TOKEN.toLowerCase() as typeof TOKEN,
    curve: CURVE,
    deployer: CREATOR,
  });
  assert.equal(a.id, b.id);
  assert.equal(a.id, opportunityId({ factory: ADDRESSES.factory, token: TOKEN }));
});

test("opportunity registry deduplicates and persists", () => {
  const dir = tmp();
  const path = join(dir, "opportunities.json");
  const first = new OpportunityRegistry(path);
  const opp = opportunity();
  assert.equal(first.has(opp.id), false);
  first.add(opp);
  assert.equal(first.has(opp.id), true);
  const second = new OpportunityRegistry(path);
  assert.equal(second.get(opp.id)?.tokenAddress, TOKEN);
  rmSync(dir, { recursive: true, force: true });
});

test("signal engine skips denylisted creators and high snipe tax", async () => {
  const strategy = new PonsSniperStrategy(
    cfg({
      creatorDenylist: [CREATOR],
    }),
  );
  const denied = await strategy.evaluate(opportunity(), context());
  assert.equal(denied.action, "SKIP");
  assert.match(denied.reason, /denylist/i);

  const taxStrategy = new PonsSniperStrategy(cfg({ maxSnipeTaxBps: 0 }));
  const taxed = await taxStrategy.evaluate(
    opportunity(),
    context({ snapshot: { ...context().snapshot, snipeBps: 9_900n } }),
  );
  assert.equal(taxed.action, "SKIP");
  if (taxed.action === "SKIP") {
    assert.equal(taxed.retryable, true);
  }
});

test("signal engine buys when filters pass", async () => {
  const strategy = new PonsSniperStrategy(cfg({ buyAmount: parseEther("0.02"), maxSlippageBps: 300 }));
  const decision = await strategy.evaluate(opportunity(), context());
  assert.equal(decision.action, "BUY");
  if (decision.action === "BUY") {
    assert.equal(decision.amountIn, parseEther("0.02"));
    assert.equal(decision.maxSlippageBps, 300);
  }
});

test("symbol and native-quote filters are configurable", async () => {
  const symbols = new PonsSniperStrategy(cfg({ symbolAllowlist: ["WAGMI"] }));
  const skipSymbol = await symbols.evaluate(opportunity(), context());
  assert.equal(skipSymbol.action, "SKIP");

  const native = new PonsSniperStrategy(cfg({ nativeQuoteOnly: true }));
  const skipPair = await native.evaluate(
    opportunity({ pairToken: ADDRESSES.usdg }),
    context({ launched: launched({ pairToken: ADDRESSES.usdg }), nativeQuote: false }),
  );
  assert.equal(skipPair.action, "SKIP");
});

test("slippage protection uses official bps math", () => {
  const engine = new PonsQuoteEngine();
  const snap = context().snapshot;
  const amountIn = parseEther("0.02");
  const quoted = quoteBuy(amountIn, snap);
  const result = engine.quoteBuy(amountIn, snap, 500);
  assert.equal(result.expectedTokensOut, quoted.tokensOut);
  assert.equal(result.minTokensOut, applySlippage(quoted.tokensOut, 500n));
  assert.ok(result.minTokensOut < result.expectedTokensOut);
  assert.ok(result.minTokensOut > 0n);
});

test("risk engine enforces size, gas reserve, duplicates, and exposure", () => {
  const engine = new SniperRiskEngine(cfg());
  const quote: SniperBuyQuote = {
    amountIn: parseEther("0.02"),
    expectedTokensOut: 1_000n,
    minTokensOut: 900n,
    spent: parseEther("0.02"),
    refund: 0n,
    fee: 0n,
    tax: 0n,
    snipeTax: 0n,
    snipeBps: 0n,
  };
  const open: Position[] = [
    {
      id: "1",
      opportunityId: "x",
      tokenAddress: TOKEN,
      curveAddress: CURVE,
      walletAddress: WALLET,
      amountBought: 1n,
      entryAmount: parseEther("0.02"),
      entryTxHash: "0x1",
      openedAt: Date.now(),
      status: "OPEN",
    },
  ];
  const base: RiskInput = {
    opportunity: opportunity(),
    amountIn: parseEther("0.02"),
    maxSlippageBps: 800,
    walletAddress: WALLET,
    nativeBalance: parseEther("1"),
    estimatedGasCost: parseEther("0.0001"),
    quote,
    context: context(),
    openPositions: [],
    entriesLastHour: 0,
  };
  assert.equal(engine.validate(base).approved, true);

  assert.equal(engine.validate({ ...base, amountIn: parseEther("1") }).approved, false);
  assert.equal(engine.validate({ ...base, nativeBalance: parseEther("0.01") }).approved, false);
  assert.equal(engine.validate({ ...base, quote: { ...quote, minTokensOut: 0n } }).approved, false);
  assert.equal(engine.validate({ ...base, openPositions: open }).reason, "Position already open for this token");
  assert.equal(engine.validate({ ...base, entriesLastHour: 10 }).approved, false);
});

test("execution store treats in-flight and confirmed as non-retryable", () => {
  const dir = tmp();
  const store = new ExecutionStore(join(dir, "executions.json"));
  store.upsert({
    opportunityId: "opp-1",
    tokenAddress: TOKEN,
    curveAddress: CURVE,
    walletAddress: WALLET,
    state: "SUBMITTED",
    txHash: "0xabc",
    dryRun: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(store.shouldSkipDuplicate("opp-1")?.state, "SUBMITTED");
  assert.equal(isInFlightState("SUBMITTED"), true);
  store.transition("opp-1", "CONFIRMED");
  assert.equal(isTerminalState("CONFIRMED"), true);
  assert.equal(store.shouldSkipDuplicate("opp-1")?.state, "CONFIRMED");
  const restarted = new ExecutionStore(join(dir, "executions.json"));
  assert.equal(restarted.shouldSkipDuplicate("opp-1")?.state, "CONFIRMED");
  rmSync(dir, { recursive: true, force: true });
});

test("UNKNOWN submission is not a license to resubmit", () => {
  const dir = tmp();
  const store = new ExecutionStore(join(dir, "executions.json"));
  store.upsert({
    opportunityId: "opp-2",
    tokenAddress: TOKEN,
    curveAddress: CURVE,
    walletAddress: WALLET,
    state: "UNKNOWN",
    nonce: 7,
    dryRun: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(store.shouldSkipDuplicate("opp-2")?.state, "UNKNOWN");
  rmSync(dir, { recursive: true, force: true });
});

test("position manager tracks one open position per token", () => {
  const dir = tmp();
  const manager = new PositionManager(join(dir, "positions.json"));
  manager.open({
    opportunityId: opportunity().id,
    tokenAddress: TOKEN,
    curveAddress: CURVE,
    walletAddress: WALLET,
    amountBought: 123n,
    entryAmount: parseEther("0.02"),
    entryTxHash: "0x1",
  });
  assert.equal(manager.hasOpenPosition(TOKEN, WALLET), true);
  assert.equal(manager.hasOpenPosition(TOKEN, OTHER), false);
  assert.equal(manager.openPositions().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("structured logger redacts private keys", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (value: unknown) => {
    lines.push(String(value));
  };
  try {
    logEvent("sniper.test", {
      privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nested: { seed: "secret-phrase", txHash: "0x1234" },
    });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.includes("0xaaaaaaaa"), false);
  assert.equal(lines[0]?.includes("[redacted]"), true);
  assert.equal(lines[0]?.includes("secret-phrase"), false);
});

test("quote engine refuses invalid slippage", () => {
  const engine = new PonsQuoteEngine();
  assert.throws(() => engine.quoteBuy(parseEther("0.01"), context().snapshot, 10_000));
});
