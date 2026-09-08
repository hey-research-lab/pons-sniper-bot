import { join } from "node:path";
import type { Address, PublicClient } from "viem";
import { tokenLaunchedEvent } from "../../abi.js";
import { ROBINHOOD_CHAIN_ID } from "../../chain.js";
import { logEvent } from "../log.js";
import { opportunityFromLaunch } from "../ids.js";
import { atomicWriteJson, readJsonOr } from "../persist.js";
import type { PonsOpportunity, PonsOpportunityDetector } from "../types.js";

export type { PonsOpportunityDetector };

export type DetectorDeps = {
  httpClient: PublicClient;
  wsClient?: PublicClient;
  factory: Address;
  mode: "event" | "polling";
  pollIntervalMs: number;
  lookbackBlocks: number;
  dataDir: string;
  onOpportunity: (opportunity: PonsOpportunity) => Promise<void> | void;
  onRpcFailure?: (error: unknown) => void;
};

type Cursor = { lastBlock: string };

export class FactoryLaunchDetector implements PonsOpportunityDetector {
  private stopped = false;
  private unwatch: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private cursorPath: string;
  private handling = false;

  constructor(private readonly deps: DetectorDeps) {
    this.cursorPath = join(deps.dataDir, "detector-cursor.json");
  }

  async start(): Promise<void> {
    this.stopped = false;
    const latest = await this.deps.httpClient.getBlockNumber();
    const cursor = readJsonOr<Cursor>(this.cursorPath, { lastBlock: latest.toString() });
    if (!cursor.lastBlock) {
      atomicWriteJson(this.cursorPath, { lastBlock: latest.toString() });
    }

    if (this.deps.mode === "event") {
      const client = this.deps.wsClient ?? this.deps.httpClient;
      try {
        this.unwatch = client.watchEvent({
          address: this.deps.factory,
          event: tokenLaunchedEvent,
          onLogs: (logs) => {
            void this.handleLogs(logs);
          },
          onError: (error) => {
            this.deps.onRpcFailure?.(error);
            logEvent("sniper.detector.watch_error", { error: error instanceof Error ? error.message : String(error) });
          },
        });
        logEvent("sniper.detector.started", {
          mode: "event",
          transport: this.deps.wsClient ? "websocket" : "http-watch",
          factory: this.deps.factory,
        });
      } catch (error) {
        this.deps.onRpcFailure?.(error);
        logEvent("sniper.detector.event_unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.startPolling();
      }
    } else {
      this.startPolling();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    logEvent("sniper.detector.stopped", {});
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    logEvent("sniper.detector.started", { mode: "polling", factory: this.deps.factory });
    void this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.deps.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.handling) return;
    this.handling = true;
    try {
      const latest = await this.deps.httpClient.getBlockNumber();
      const cursor = readJsonOr<Cursor>(this.cursorPath, { lastBlock: latest.toString() });
      const last = BigInt(cursor.lastBlock);
      const fromBlock = last > BigInt(this.deps.lookbackBlocks) ? last - BigInt(this.deps.lookbackBlocks) : 0n;
      if (fromBlock > latest) return;
      const logs = await this.deps.httpClient.getLogs({
        address: this.deps.factory,
        event: tokenLaunchedEvent,
        fromBlock,
        toBlock: latest,
      });
      await this.handleLogs(logs);
      atomicWriteJson(this.cursorPath, { lastBlock: latest.toString() });
    } catch (error) {
      this.deps.onRpcFailure?.(error);
      logEvent("sniper.detector.poll_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.handling = false;
    }
  }

  private async handleLogs(
    logs: Array<{
      args: {
        token?: Address;
        curve?: Address;
        deployer?: Address;
        pairToken?: Address;
        launchConfigId?: bigint;
        graduationThreshold?: bigint;
      };
      transactionHash?: `0x${string}` | null;
      blockNumber?: bigint | null;
      logIndex?: number | null;
    }>,
  ): Promise<void> {
    for (const log of logs) {
      if (!log.args.token || !log.args.curve || !log.args.deployer) continue;
      const opportunity = opportunityFromLaunch({
        factory: this.deps.factory,
        token: log.args.token,
        curve: log.args.curve,
        deployer: log.args.deployer,
        pairToken: log.args.pairToken,
        launchConfigId: log.args.launchConfigId,
        graduationThreshold: log.args.graduationThreshold,
        transactionHash: log.transactionHash ?? undefined,
        blockNumber: log.blockNumber ?? undefined,
        logIndex: log.logIndex ?? undefined,
      });
      logEvent("sniper.opportunity.detected", {
        opportunityId: opportunity.id,
        token: opportunity.tokenAddress,
        curve: opportunity.curveAddress,
        creator: opportunity.creator,
        chainId: ROBINHOOD_CHAIN_ID,
      });
      await this.deps.onOpportunity(opportunity);
    }
  }
}
