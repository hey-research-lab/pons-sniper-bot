import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "./chain.js";
import type { AppConfig } from "./env.js";

export type Clients = {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account?: Account;
};

export type RpcTransportOptions = {
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
};

export function httpTransport(rpcUrl: string, options: RpcTransportOptions = {}): Transport {
  return http(rpcUrl, {
    timeout: options.timeoutMs ?? 15_000,
    retryCount: options.retryCount ?? 2,
    retryDelay: options.retryDelayMs ?? 250,
  });
}

export function createClients(cfg: AppConfig, privateKey?: Hex): Clients {
  const chain = robinhoodChain(cfg.rpcUrl);
  const transport = httpTransport(cfg.rpcUrl, {
    timeoutMs: cfg.rpcTimeoutMs,
    retryCount: cfg.rpcRetries,
  });
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKey ? privateKeyToAccount(privateKey) : undefined;
  const walletClient = createWalletClient({
    chain,
    transport,
    account,
  });
  return { chain, publicClient, walletClient, account };
}

export function createWsPublicClient(cfg: AppConfig): PublicClient | undefined {
  if (!cfg.wsUrl) return undefined;
  const chain = robinhoodChain(cfg.rpcUrl);
  return createPublicClient({
    chain,
    transport: webSocket(cfg.wsUrl, {
      timeout: cfg.rpcTimeoutMs ?? 15_000,
      retryCount: cfg.rpcRetries ?? 2,
    }),
  });
}
