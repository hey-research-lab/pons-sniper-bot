import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Address, type Hex, isAddress, isHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readJsonFile } from "./env.js";

export type StoredWallet = {
  address: Address;
  privateKey: Hex;
};

export type WalletFile = {
  chainId: number;
  createdAt: string;
  wallets: StoredWallet[];
};

export function generateWallets(count: number): StoredWallet[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("--count must be a positive integer");
  }
  if (count > 32) {
    throw new Error("Pons v2 allows at most 32 snipe-tax exemptions");
  }
  return Array.from({ length: count }, () => {
    const privateKey = generatePrivateKey();
    return { address: privateKeyToAccount(privateKey).address, privateKey };
  });
}

export function loadWalletFile(path: string): StoredWallet[] {
  const file = readJsonFile<WalletFile>(path);
  if (!Array.isArray(file.wallets) || file.wallets.length === 0) {
    throw new Error(`No wallets in ${path}`);
  }
  return file.wallets.map((wallet, i) => {
    if (!isAddress(wallet.address) || !isHex(wallet.privateKey) || wallet.privateKey.length !== 66) {
      throw new Error(`Invalid wallet entry at index ${i}`);
    }
    const derived = privateKeyToAccount(wallet.privateKey).address;
    if (derived.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`Wallet ${i} address does not match private key`);
    }
    return { address: derived, privateKey: wallet.privateKey };
  });
}

export function saveWalletFile(path: string, wallets: StoredWallet[], chainId: number): string {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const body: WalletFile = {
    chainId,
    createdAt: new Date().toISOString(),
    wallets,
  };
  writeFileSync(abs, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return abs;
}
