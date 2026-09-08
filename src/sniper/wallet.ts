import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { SniperConfig } from "./config.js";

export type SniperWallet = {
  address: PrivateKeyAccount["address"];
  signer: PrivateKeyAccount;
  enabled: boolean;
  maxPositionSize: bigint;
  gasReserve: bigint;
};

export function loadSniperWallet(cfg: SniperConfig): SniperWallet {
  const key = cfg.sniperKey;
  if (!key) {
    throw new Error("Set SNIPER_PRIVATE_KEY or MASTER_PRIVATE_KEY for the sniper wallet");
  }
  const signer = privateKeyToAccount(key as Hex);
  return {
    address: signer.address,
    signer,
    enabled: cfg.enabled,
    maxPositionSize: cfg.maxPositionSize,
    gasReserve: cfg.gasReserve,
  };
}
