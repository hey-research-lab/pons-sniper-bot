import { atomicWriteJson, readJsonOr } from "./persist.js";

export type SniperMetrics = {
  opportunitiesDetected: number;
  opportunitiesSkipped: number;
  buySignals: number;
  riskRejections: number;
  transactionsSubmitted: number;
  transactionsConfirmed: number;
  transactionsReverted: number;
  rpcFailures: number;
  detectionToSubmitMs: number[];
  gasUsed: string[];
  openPositions: number;
};

const EMPTY: SniperMetrics = {
  opportunitiesDetected: 0,
  opportunitiesSkipped: 0,
  buySignals: 0,
  riskRejections: 0,
  transactionsSubmitted: 0,
  transactionsConfirmed: 0,
  transactionsReverted: 0,
  rpcFailures: 0,
  detectionToSubmitMs: [],
  gasUsed: [],
  openPositions: 0,
};

export class MetricsStore {
  constructor(private readonly path: string) {}

  read(): SniperMetrics {
    return { ...EMPTY, ...readJsonOr<Partial<SniperMetrics>>(this.path, {}) };
  }

  private write(next: SniperMetrics): void {
    const capped: SniperMetrics = {
      ...next,
      detectionToSubmitMs: next.detectionToSubmitMs.slice(-200),
      gasUsed: next.gasUsed.slice(-200),
    };
    atomicWriteJson(this.path, capped);
  }

  increment(key: Exclude<keyof SniperMetrics, "detectionToSubmitMs" | "gasUsed" | "openPositions">): void {
    const current = this.read();
    current[key] += 1;
    this.write(current);
  }

  setOpenPositions(count: number): void {
    const current = this.read();
    current.openPositions = count;
    this.write(current);
  }

  recordLatency(ms: number): void {
    const current = this.read();
    current.detectionToSubmitMs.push(ms);
    this.write(current);
  }

  recordGas(used: bigint): void {
    const current = this.read();
    current.gasUsed.push(used.toString());
    this.write(current);
  }

  snapshot(): {
    observed: SniperMetrics;
    averageDetectionToSubmitMs: number | null;
    averageGasUsed: string | null;
  } {
    const observed = this.read();
    const avgMs =
      observed.detectionToSubmitMs.length === 0
        ? null
        : Math.round(
            observed.detectionToSubmitMs.reduce((sum, n) => sum + n, 0) / observed.detectionToSubmitMs.length,
          );
    const gas = observed.gasUsed.map((n) => BigInt(n));
    const avgGas =
      gas.length === 0 ? null : (gas.reduce((sum, n) => sum + n, 0n) / BigInt(gas.length)).toString();
    return { observed, averageDetectionToSubmitMs: avgMs, averageGasUsed: avgGas };
  }
}
