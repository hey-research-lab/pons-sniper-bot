import { formatUnits, type Address, type Hex } from "viem";
import { explorerAddress, explorerTx } from "./chain.js";

export function fmtUnits(value: bigint, decimals = 18, digits = 6): string {
  const raw = formatUnits(value, decimals);
  const [whole, frac = ""] = raw.split(".");
  if (digits === 0) return whole ?? "0";
  const trimmed = (frac + "0".repeat(digits)).slice(0, digits).replace(/0+$/, "");
  return trimmed.length > 0 ? `${whole}.${trimmed}` : (whole ?? "0");
}

export function fmtEth(value: bigint, digits = 6): string {
  return `${fmtUnits(value, 18, digits)} ETH`;
}

export function short(value: Address | Hex): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function txLine(hash: Hex): string {
  return `${hash} ${explorerTx(hash)}`;
}

export function addrLine(address: Address): string {
  return `${address} ${explorerAddress(address)}`;
}
