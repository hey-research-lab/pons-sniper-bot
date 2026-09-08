import { flagBool, parseArgs, type Flags } from "../args.js";
import { ROBINHOOD_CHAIN_ID } from "../chain.js";
import { createClients } from "../clients.js";
import { addrLine, fmtEth } from "../format.js";
import { readFactoryStatus } from "../protocol.js";
import { assertRobinhood } from "../tx.js";
import { createSniperBot } from "./bot.js";
import { loadSniperConfig } from "./config.js";
import { logEvent } from "./log.js";
import { checkRpcHealth } from "./protocolContext.js";
import { loadSniperWallet } from "./wallet.js";

export function sniperHelp(): string {
  return `
pons sniper — Pons v2 launch sniper on Robinhood Chain (${ROBINHOOD_CHAIN_ID})

 sniper status                 RPC, factory, wallet, positions, metrics
 sniper config                 Print non-secret configuration
 sniper run [--dry-run|--live] Detect → filter → quote → risk → (optionally) buy
 sniper test                   Local self-check (never broadcasts)
 sniper reconcile              Re-read receipts, balances, and positions

Dry-run is the default. Live buys require --live and SNIPER_DRY_RUN=false.

Env: RH_RPC_URL, RH_WS_URL, SNIPER_PRIVATE_KEY or MASTER_PRIVATE_KEY
`.trim();
}

export async function cmdSniper(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    console.log(sniperHelp());
    return;
  }
  const sub = argv[0];
  const { flags } = parseArgs(argv);
  if (sub === "status") await cmdStatus();
  else if (sub === "config") cmdConfig();
  else if (sub === "run") await cmdRun(flags);
  else if (sub === "test") await cmdTest();
  else if (sub === "reconcile") await cmdReconcile();
  else throw new Error(`Unknown sniper command: ${sub}\n${sniperHelp()}`);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadSniperConfig();
  const { publicClient } = createClients(cfg, cfg.sniperKey);
  await assertRobinhood(publicClient);
  const health = await checkRpcHealth(publicClient);
  let walletAddress: `0x${string}` | undefined;
  try {
    walletAddress = loadSniperWallet(cfg).address;
  } catch {
    walletAddress = undefined;
  }
  const status = await readFactoryStatus(
    publicClient,
    cfg.factory,
    cfg.launchAndBuy,
    walletAddress ?? cfg.factory,
  );
  console.log(`Chain ${health.chainId} block ${health.blockNumber}`);
  console.log(`RPC ${cfg.rpcUrl}`);
  if (cfg.wsUrl) console.log(`WS ${cfg.wsUrl}`);
  console.log(`Factory ${addrLine(status.factory)}`);
  console.log(`Launch+buy ${addrLine(status.launchAndBuy)}`);
  if (walletAddress) {
    const balance = await publicClient.getBalance({ address: walletAddress });
    console.log(`Wallet ${addrLine(walletAddress)} ${fmtEth(balance)}`);
  } else {
    console.log("Wallet not configured (set SNIPER_PRIVATE_KEY or MASTER_PRIVATE_KEY)");
  }
  console.log(`Dry run ${cfg.dryRun}`);
  console.log(`Detection ${cfg.detectionMode}`);
  if (walletAddress) {
    const bot = createSniperBot(cfg);
    const metrics = bot.deps.metrics.snapshot();
    console.log(`Open positions ${bot.deps.positions.openPositions().length}/${cfg.maxPositions}`);
    console.log(`Detected ${metrics.observed.opportunitiesDetected} skipped ${metrics.observed.opportunitiesSkipped}`);
    console.log(`Buys ${metrics.observed.buySignals} submitted ${metrics.observed.transactionsSubmitted}`);
    console.log(`Confirmed ${metrics.observed.transactionsConfirmed} reverted ${metrics.observed.transactionsReverted}`);
    if (metrics.averageDetectionToSubmitMs !== null) {
      console.log(`Avg detect→submit ${metrics.averageDetectionToSubmitMs} ms`);
    }
  }
}

function cmdConfig(): void {
  const cfg = loadSniperConfig();
  console.log(
    JSON.stringify(
      {
        rpcUrl: cfg.rpcUrl,
        wsUrl: cfg.wsUrl,
        factory: cfg.factory,
        launchAndBuy: cfg.launchAndBuy,
        dryRun: cfg.dryRun,
        enabled: cfg.enabled,
        detectionMode: cfg.detectionMode,
        buyAmount: cfg.buyAmount.toString(),
        maxSlippageBps: cfg.maxSlippageBps,
        gasReserve: cfg.gasReserve.toString(),
        maxPositions: cfg.maxPositions,
        maxExposure: cfg.maxExposure.toString(),
        maxSnipeTaxBps: cfg.maxSnipeTaxBps,
        nativeQuoteOnly: cfg.nativeQuoteOnly,
        dataDir: cfg.dataDir,
      },
      null,
      2,
    ),
  );
}

async function cmdRun(flags: Flags): Promise<void> {
  const live = flagBool(flags, "live");
  const dryFlag = flagBool(flags, "dry-run");
  if (live && dryFlag) throw new Error("Use either --dry-run or --live, not both");
  const cfg = loadSniperConfig({ dryRun: live ? false : true });
  if (live && process.env.SNIPER_DRY_RUN !== "false") {
    throw new Error("Live mode requires SNIPER_DRY_RUN=false in the environment");
  }
  if (!cfg.dryRun) {
    logEvent("sniper.live.enabled", { warning: "Live execution will broadcast curve buys" });
  }
  const bot = createSniperBot(cfg);
  const stop = async () => {
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  await bot.start();
  console.log(`Sniper running (${cfg.dryRun ? "dry-run" : "LIVE"}) on wallet ${bot.deps.wallet.address}`);
  console.log("Ctrl+C to stop");
  await new Promise(() => undefined);
}

async function cmdTest(): Promise<void> {
  const cfg = loadSniperConfig({ dryRun: true });
  const { publicClient } = createClients(cfg, cfg.sniperKey);
  await assertRobinhood(publicClient);
  await checkRpcHealth(publicClient);
  const wallet = loadSniperWallet(cfg);
  if (cfg.buyAmount <= 0n) throw new Error("SNIPER_BUY_AMOUNT must be > 0");
  if (cfg.maxSlippageBps <= 0 || cfg.maxSlippageBps >= 10_000) {
    throw new Error("SNIPER_MAX_SLIPPAGE_BPS must be in (0, 10000)");
  }
  console.log("sniper test ok");
  console.log(`wallet ${wallet.address}`);
  console.log("dry-run forced; no transaction will be broadcast");
}

async function cmdReconcile(): Promise<void> {
  const cfg = loadSniperConfig({ dryRun: true });
  const bot = createSniperBot(cfg);
  await assertRobinhood(bot.deps.publicClient);
  const report = await bot.deps.reconciler.reconcile();
  console.log(`Native ${fmtEth(report.nativeBalance)}`);
  console.log(`In-flight ${report.inFlight}`);
  console.log(`Open positions ${report.openPositions}`);
  console.log(`Updated ${report.updated.length}`);
}
