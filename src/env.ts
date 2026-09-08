import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { ADDRESSES, PUBLIC_RPC } from "./chain.js";

loadDotenv();

export type AppConfig = {
  rpcUrl: string;
  wsUrl?: string;
  rpcTimeoutMs: number;
  rpcRetries: number;
  masterKey?: Hex;
  factory: Address;
  launchAndBuy: Address;
};

function optionalHexKey(value: string | undefined, label: string): Hex | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!isHex(trimmed) || trimmed.length !== 66) {
    throw new Error(`${label} must be a 32-byte 0x-prefixed hex key`);
  }
  return trimmed;
}

function optionalAddress(value: string | undefined, fallback: Address): Address {
  if (!value) return fallback;
  if (!isAddress(value)) throw new Error(`Invalid address: ${value}`);
  return value;
}

function optionalInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid integer: ${value}`);
  return n;
}

export function loadAppConfig(): AppConfig {
  return {
    rpcUrl: process.env.RH_RPC_URL?.trim() || PUBLIC_RPC,
    wsUrl: process.env.RH_WS_URL?.trim() || undefined,
    rpcTimeoutMs: optionalInt(process.env.RH_RPC_TIMEOUT_MS, 15_000),
    rpcRetries: optionalInt(process.env.RH_RPC_RETRIES, 2),
    masterKey: optionalHexKey(process.env.MASTER_PRIVATE_KEY, "MASTER_PRIVATE_KEY"),
    factory: optionalAddress(process.env.PONS_FACTORY, ADDRESSES.factory),
    launchAndBuy: optionalAddress(process.env.PONS_LAUNCH_AND_BUY, ADDRESSES.launchAndBuy),
  };
}

export function requireMasterKey(cfg: AppConfig): Hex {
  if (!cfg.masterKey) {
    throw new Error("Set MASTER_PRIVATE_KEY in .env or the environment");
  }
  return cfg.masterKey;
}

export function readJsonFile<T>(path: string): T {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}

export { optionalHexKey, optionalAddress, optionalInt };
