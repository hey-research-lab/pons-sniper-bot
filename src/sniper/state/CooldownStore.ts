import { join } from "node:path";
import { atomicWriteJson, readJsonOr } from "../persist.js";

export type CooldownState = {
  lastSkipAt?: number;
  lastExecutionAt?: number;
};

export class CooldownStore {
  constructor(private readonly path: string) {}

  read(): CooldownState {
    return readJsonOr<CooldownState>(this.path, {});
  }

  markSkip(): void {
    atomicWriteJson(this.path, { ...this.read(), lastSkipAt: Date.now() });
  }

  markExecution(): void {
    atomicWriteJson(this.path, { ...this.read(), lastExecutionAt: Date.now() });
  }
}

export function cooldownPath(dataDir: string): string {
  return join(dataDir, "cooldowns.json");
}
