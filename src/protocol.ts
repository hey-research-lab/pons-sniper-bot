import { type Address, type PublicClient, zeroAddress } from "viem";
import { curveAbi, erc20Abi, factoryAbi } from "./abi.js";
import { NATIVE_PAIR } from "./chain.js";
import { snapshotFromConfig, type CurveSnapshot } from "./quote.js";

export type LaunchConfig = {
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
};

export type FactoryStatus = {
  factory: Address;
  launchAndBuy: Address;
  launchFee: bigint;
  launchEnabled: boolean;
  canLaunch: boolean;
  maxCreatorTaxBps: bigint;
  configs: Array<LaunchConfig & { id: bigint }>;
};

export type TokenParamsInput = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  website?: string;
  farcaster?: string;
  creatorFeeRecipient: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  expectedEconomics: `0x${string}`;
  salt: `0x${string}`;
};

export type LaunchedToken = {
  token: Address;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: number;
  sweptQuote: bigint;
  sweptTokens: bigint;
  sweptAt: bigint;
  exists: boolean;
};

export async function readFactoryStatus(
  client: PublicClient,
  factory: Address,
  launchAndBuy: Address,
  launcher: Address = zeroAddress,
): Promise<FactoryStatus> {
  const [launchFee, launchEnabled, canLaunch, maxCreatorTaxBps, count] = await Promise.all([
    client.readContract({ address: factory, abi: factoryAbi, functionName: "launchFee" }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "launchEnabled" }),
    client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "canLaunch",
      args: [launcher],
    }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
    client.readContract({ address: factory, abi: factoryAbi, functionName: "launchConfigCount" }),
  ]);

  const configs = await Promise.all(
    Array.from({ length: Number(count) }, async (_, id) => {
      const config = await client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "getLaunchConfig",
        args: [BigInt(id)],
      });
      return { id: BigInt(id), ...config };
    }),
  );

  return {
    factory,
    launchAndBuy,
    launchFee,
    launchEnabled,
    canLaunch,
    maxCreatorTaxBps,
    configs,
  };
}

export async function readLaunchConfig(
  client: PublicClient,
  factory: Address,
  launchConfigId: bigint,
): Promise<LaunchConfig> {
  return client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchConfig",
    args: [launchConfigId],
  });
}

export async function readLaunchedToken(
  client: PublicClient,
  factory: Address,
  token: Address,
): Promise<LaunchedToken> {
  return client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getLaunchedToken",
    args: [token],
  });
}

export async function assertPairUsable(
  client: PublicClient,
  factory: Address,
  pairToken: Address,
): Promise<void> {
  if (pairToken === NATIVE_PAIR) return;
  const approved = await client.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "approvedPairTokens",
    args: [pairToken],
  });
  if (!approved) {
    throw new Error(`Pair token ${pairToken} is not approved on the v2 factory`);
  }
}

export async function readCurveSnapshot(
  client: PublicClient,
  curve: Address,
  recipient: Address,
): Promise<CurveSnapshot> {
  const [reserves, sellable, feeBps, creatorTaxBps, snipeBps] = await Promise.all([
    client.readContract({ address: curve, abi: curveAbi, functionName: "getReserves" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "sellableTokens" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "feeBps" }),
    client.readContract({ address: curve, abi: curveAbi, functionName: "creatorTaxBps" }),
    client.readContract({
      address: curve,
      abi: curveAbi,
      functionName: "currentSnipeTaxBps",
      args: [recipient],
    }),
  ]);
  return {
    quoteReserve: reserves[0],
    tokenReserve: reserves[1],
    sellable,
    feeBps,
    creatorTaxBps,
    snipeBps,
  };
}

export function tokenParams(input: TokenParamsInput) {
  return {
    name: input.name,
    symbol: input.symbol,
    logo: input.logo,
    description: input.description,
    socials: {
      twitter: input.twitter ?? "",
      telegram: input.telegram ?? "",
      discord: input.discord ?? "",
      website: input.website ?? "",
      farcaster: input.farcaster ?? "",
    },
    creatorFeeRecipient: input.creatorFeeRecipient,
    creatorTaxBps: input.creatorTaxBps,
    buybackEnabled: input.buybackEnabled,
    expectedEconomics: input.expectedEconomics,
    salt: input.salt,
  };
}

export async function readErc20Meta(client: PublicClient, token: Address) {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { name, symbol, decimals };
}

export function snapshotFromLaunchConfig(
  config: LaunchConfig,
  creatorTaxBps: bigint,
  snipeBps = 0n,
): CurveSnapshot {
  return snapshotFromConfig({
    supply: config.supply,
    phantomQuote: config.phantomQuote,
    threshold: config.graduationThreshold,
    feeBps: config.curveFeeBps,
    creatorTaxBps,
    snipeBps,
  });
}
