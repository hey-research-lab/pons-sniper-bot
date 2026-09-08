import { atomicWriteJson, readJsonOr } from "../persist.js";
import type { ExecutionRecord, TxLifecycleState } from "../types.js";

const TERMINAL: ReadonlySet<TxLifecycleState> = new Set([
  "CONFIRMED",
  "REVERTED",
  "SKIPPED",
  "FAILED",
]);

export function isTerminalState(state: TxLifecycleState): boolean {
  return TERMINAL.has(state);
}

export function isInFlightState(state: TxLifecycleState): boolean {
  return state === "SIGNED" || state === "SUBMITTED" || state === "PENDING" || state === "UNKNOWN";
}

export class ExecutionStore {
  private records = new Map<string, ExecutionRecord>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    const stored = readJsonOr<{ records: ExecutionRecord[] }>(this.path, { records: [] });
    for (const record of stored.records ?? []) {
      this.records.set(record.opportunityId, record);
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, { records: [...this.records.values()] });
  }

  get(opportunityId: string): ExecutionRecord | undefined {
    return this.records.get(opportunityId);
  }

  upsert(record: ExecutionRecord): ExecutionRecord {
    this.records.set(record.opportunityId, record);
    this.persist();
    return record;
  }

  transition(
    opportunityId: string,
    state: TxLifecycleState,
    patch: Partial<ExecutionRecord> = {},
  ): ExecutionRecord {
    const current = this.records.get(opportunityId);
    if (!current) {
      throw new Error(`No execution record for ${opportunityId}`);
    }
    return this.upsert({
      ...current,
      ...patch,
      opportunityId,
      state,
      updatedAt: Date.now(),
    });
  }

  shouldSkipDuplicate(opportunityId: string): ExecutionRecord | undefined {
    const current = this.records.get(opportunityId);
    if (!current) return undefined;
    if (isTerminalState(current.state) || isInFlightState(current.state)) {
      return current;
    }
    return undefined;
  }

  inFlight(): ExecutionRecord[] {
    return [...this.records.values()].filter((record) => isInFlightState(record.state));
  }

  all(): ExecutionRecord[] {
    return [...this.records.values()];
  }
}
