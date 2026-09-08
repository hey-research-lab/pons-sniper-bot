import { mkdirSync } from "node:fs";
import { createClients, createWsPublicClient } from "../clients.js";
import { assertRobinhood } from "../tx.js";
import type { SniperConfig } from "./config.js";
import { FactoryLaunchDetector } from "./detector/PonsOpportunityDetector.js";
import { NonceManager } from "./execution/NonceManager.js";
import { PonsSniperExecutor } from "./execution/PonsSniperExecutor.js";
import { logEvent } from "./log.js";
import { createStores, handleOpportunity, type PipelineDeps } from "./pipeline.js";
import { checkRpcHealth } from "./protocolContext.js";
import { PonsQuoteEngine } from "./quote/PonsQuoteEngine.js";
import { SniperRiskEngine } from "./risk/SniperRiskEngine.js";
import { PonsSniperStrategy } from "./strategy/PonsSniperStrategy.js";
import { loadSniperWallet } from "./wallet.js";

export function createSniperBot(cfg: SniperConfig) {
  mkdirSync(cfg.dataDir, { recursive: true });
  const wallet = loadSniperWallet(cfg);
  const { publicClient, walletClient, account, chain } = createClients(cfg, cfg.sniperKey);
  if (!account) throw new Error("Sniper account missing");
  let wsClient;
  try {
    wsClient = createWsPublicClient(cfg);
  } catch (error) {
    logEvent("sniper.rpc.ws_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const stores = createStores(cfg, publicClient, wallet.address);
  const nonce = new NonceManager(publicClient);
  const executor = new PonsSniperExecutor({
    cfg,
    publicClient,
    walletClient,
    account,
    chain,
    nonce,
    store: stores.executions,
  });
  const deps: PipelineDeps = {
    cfg,
    publicClient,
    walletClient,
    account,
    chain,
    wallet,
    ...stores,
    strategy: new PonsSniperStrategy(cfg),
    risk: new SniperRiskEngine(cfg),
    quotes: new PonsQuoteEngine(),
    executor,
    reconciler: stores.reconciler,
  };

  const detector = new FactoryLaunchDetector({
    httpClient: publicClient,
    wsClient,
    factory: cfg.factory,
    mode: cfg.detectionMode,
    pollIntervalMs: cfg.pollIntervalMs,
    lookbackBlocks: cfg.pollLookbackBlocks,
    dataDir: cfg.dataDir,
    onOpportunity: (opportunity) => handleOpportunity(deps, opportunity),
    onRpcFailure: () => stores.metrics.increment("rpcFailures"),
  });

  let reconcileTimer: ReturnType<typeof setInterval> | undefined;

  return {
    deps,
    async start(): Promise<void> {
      if (!cfg.enabled) throw new Error("SNIPER_ENABLED is false");
      await assertRobinhood(publicClient);
      const health = await checkRpcHealth(publicClient);
      logEvent("sniper.started", {
        dryRun: cfg.dryRun,
        mode: cfg.detectionMode,
        wallet: wallet.address,
        factory: cfg.factory,
        block: health.blockNumber.toString(),
      });
      await stores.reconciler.reconcile();
      await detector.start();
      reconcileTimer = setInterval(() => {
        void stores.reconciler.reconcile().catch((error) => {
          stores.metrics.increment("rpcFailures");
          logEvent("sniper.reconcile.error", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, cfg.reconcileIntervalMs);
    },
    async stop(): Promise<void> {
      if (reconcileTimer) clearInterval(reconcileTimer);
      await detector.stop();
      logEvent("sniper.stopped", {});
    },
  };
}
