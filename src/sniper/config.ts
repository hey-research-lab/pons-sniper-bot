import { resolve } from "node:path";
import { type Address, type Hex, isAddress, parseEther } from "viem";
import { NATIVE_PAIR } from "../chain.js";
import { loadAppConfig, optionalHexKey, optionalInt, type AppConfig } from "../env.js";
import type { DetectionMode } from "./types.js";

export type SniperConfig = AppConfig & {
  enabled: boolean;
  dryRun: boolean;
  detectionMode: DetectionMode;
  pollIntervalMs: number;
  pollLookbackBlocks: number;
  dataDir: string;
  sniperKey?: Hex;
  buyAmount: bigint;
  maxSlippageBps: number;
  gasReserve: bigint;
  maxPositionSize: bigint;
  maxPositions: number;
  maxExposure: bigint;
  maxTokenExposure: bigint;
  maxEntriesPerHour: number;
  cooldownMs: number;
  executionCooldownMs: number;
  onePositionPerToken: boolean;
  nativeQuoteOnly: boolean;
  maxSnipeTaxBps: number;
  maxCreatorTaxBps: number;
  minRealQuote: bigint;
  maxRealQuote?: bigint;
  creatorAllowlist: Address[];
  creatorDenylist: Address[];
  symbolAllowlist: string[];
  symbolDenylist: string[];
  pairAllowlist: Address[];
  reconcileIntervalMs: number;
  receiptTimeoutMs: number;
  snipeTaxRetryMs: number;
  snipeTaxRetryWindowMs: number;
};

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`Invalid boolean: ${value}`);
}

function envEther(value: string | undefined, fallback: string): bigint {
  return parseEther((value?.trim() || fallback) as `${string}`);
}

function envOptionalEther(value: string | undefined): bigint | undefined {
  if (!value?.trim()) return undefined;
  return parseEther(value.trim() as `${string}`);
}

function csvAddresses(value: string | undefined): Address[] {
  if (!value?.trim()) return [];
  return value.split(",").map((part, i) => {
    const trimmed = part.trim();
    if (!isAddress(trimmed)) throw new Error(`Invalid address at index ${i}: ${trimmed}`);
    return trimmed;
  });
}

function csvSymbols(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.toUpperCase());
}

function detectionMode(value: string | undefined): DetectionMode {
  const mode = (value?.trim() || "event").toLowerCase();
  if (mode === "event" || mode === "polling") return mode;
  throw new Error(`SNIPER_DETECTION_MODE must be event or polling, got ${value}`);
}

export function loadSniperConfig(overrides: Partial<Pick<SniperConfig, "dryRun">> = {}): SniperConfig {
  const app = loadAppConfig();
  const dryRunEnv = envBool(process.env.SNIPER_DRY_RUN, true);
  return {
    ...app,
    enabled: envBool(process.env.SNIPER_ENABLED, true),
    dryRun: overrides.dryRun ?? dryRunEnv,
    detectionMode: detectionMode(process.env.SNIPER_DETECTION_MODE),
    pollIntervalMs: optionalInt(process.env.SNIPER_POLL_INTERVAL_MS, 2_000),
    pollLookbackBlocks: optionalInt(process.env.SNIPER_POLL_LOOKBACK_BLOCKS, 4),
    dataDir: resolve(process.env.SNIPER_DATA_DIR?.trim() || "./data/sniper"),
    sniperKey: optionalHexKey(process.env.SNIPER_PRIVATE_KEY, "SNIPER_PRIVATE_KEY") ?? app.masterKey,
    buyAmount: envEther(process.env.SNIPER_BUY_AMOUNT, "0.02"),
    maxSlippageBps: optionalInt(process.env.SNIPER_MAX_SLIPPAGE_BPS, 800),
    gasReserve: envEther(process.env.SNIPER_GAS_RESERVE, "0.0004"),
    maxPositionSize: envEther(process.env.SNIPER_MAX_POSITION_SIZE, "0.05"),
    maxPositions: optionalInt(process.env.SNIPER_MAX_POSITIONS, 5),
    maxExposure: envEther(process.env.SNIPER_MAX_EXPOSURE, "0.2"),
    maxTokenExposure: envEther(process.env.SNIPER_MAX_TOKEN_EXPOSURE, "0.05"),
    maxEntriesPerHour: optionalInt(process.env.SNIPER_MAX_ENTRIES_PER_HOUR, 10),
    cooldownMs: optionalInt(process.env.SNIPER_COOLDOWN_MS, 15_000),
    executionCooldownMs: optionalInt(process.env.SNIPER_EXECUTION_COOLDOWN_MS, 15_000),
    onePositionPerToken: envBool(process.env.SNIPER_ONE_POSITION_PER_TOKEN, true),
    nativeQuoteOnly: envBool(process.env.SNIPER_NATIVE_QUOTE_ONLY, true),
    maxSnipeTaxBps: optionalInt(process.env.SNIPER_MAX_SNIPE_TAX_BPS, 0),
    maxCreatorTaxBps: optionalInt(process.env.SNIPER_MAX_CREATOR_TAX_BPS, 500),
    minRealQuote: envEther(process.env.SNIPER_MIN_REAL_QUOTE, "0"),
    maxRealQuote: envOptionalEther(process.env.SNIPER_MAX_REAL_QUOTE),
    creatorAllowlist: csvAddresses(process.env.SNIPER_CREATOR_ALLOWLIST),
    creatorDenylist: csvAddresses(process.env.SNIPER_CREATOR_DENYLIST),
    symbolAllowlist: csvSymbols(process.env.SNIPER_SYMBOL_ALLOWLIST),
    symbolDenylist: csvSymbols(process.env.SNIPER_SYMBOL_DENYLIST),
    pairAllowlist: csvAddresses(process.env.SNIPER_PAIR_ALLOWLIST),
    reconcileIntervalMs: optionalInt(process.env.SNIPER_RECONCILE_INTERVAL_MS, 15_000),
    receiptTimeoutMs: optionalInt(process.env.SNIPER_RECEIPT_TIMEOUT_MS, 60_000),
    snipeTaxRetryMs: optionalInt(process.env.SNIPER_SNIPE_TAX_RETRY_MS, 750),
    snipeTaxRetryWindowMs: optionalInt(process.env.SNIPER_SNIPE_TAX_RETRY_WINDOW_MS, 8_000),
  };
}

export function defaultPairAllowlist(cfg: SniperConfig): Address[] {
  if (cfg.pairAllowlist.length > 0) return cfg.pairAllowlist;
  if (cfg.nativeQuoteOnly) return [NATIVE_PAIR];
  return [];
}
