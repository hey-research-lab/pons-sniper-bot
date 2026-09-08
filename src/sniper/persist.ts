import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function atomicWriteJson(path: string, value: unknown): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
  renameSync(tmp, abs);
}

export function readJsonOr<T>(path: string, fallback: T): T {
  const abs = resolve(path);
  if (!existsSync(abs)) return fallback;
  return JSON.parse(readFileSync(abs, "utf8")) as T;
}
