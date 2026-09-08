#!/usr/bin/env node
import { isAddress, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flagBool, flagInt, flagOptional, flagString, parseArgs, type Flags } from "./args.js";
import { ADDRESSES, MAX_EXEMPTIONS, NATIVE_PAIR, ROBINHOOD_CHAIN_ID } from "./chain.js";
import { createClients } from "./clients.js";
import { loadAppConfig, requireMasterKey } from "./env.js";
import { addrLine, fmtEth, fmtUnits, txLine } from "./format.js";
import { prepareLaunch, sendLaunch, simulateLaunch, type LaunchPlan } from "./launch.js";
import { readFactoryStatus } from "./protocol.js";
import { cmdSniper, sniperHelp } from "./sniper/cli.js";
import { resolveCurve, sellPercent, sendCurveBuys } from "./trade.js";
import { assertRobinhood } from "./tx.js";
import { generateWallets, loadWalletFile, saveWalletFile } from "./wallets.js";
import { fundWallets, sweepWallets, walletBalances } from "./walletsOnchain.js";

function help(): string {
  return `
pons-bundler — Pons v2 launch bundler and sniper on Robinhood Chain (${ROBINHOOD_CHAIN_ID})

 status
 wallets generate --count <n> [--out wallets.json]
 wallets list --file wallets.json
 wallets fund --file wallets.json --each <eth>
 wallets sweep --file wallets.json
 launch --name <name> --symbol <sym> --master-buy <eth> [--file wallets.json] [--each-buy <eth>] [options]
 buy --token <addr> --file wallets.json --each-buy <eth>
 sell --token <addr> --file wallets.json [--percent 100]
 sniper status | config | run | test | reconcile

Launch options:
  --dry-run          Simulate launchAndBuy, do not broadcast
  --pair <addr>      Quote asset (default native ETH)
  --config-id <n>    Launch config id (default 0)
  --logo <url>
  --description <text>
  --creator-tax <bps> Extra creator tax, cap is on-chain (default 0)
  --no-buyback
  --slippage <bps>   Default 800
  --recipient <addr> Seed-buy recipient (default master)

${sniperHelp()}

Env: RH_RPC_URL, MASTER_PRIVATE_KEY, SNIPER_PRIVATE_KEY
`.trim();
}

function asAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not an address: ${value}`);
  return value;
}

function parsePair(flags: Flags): Address {
  const raw = flagOptional(flags, "pair");
  if (!raw || raw === "native" || raw === "eth") return NATIVE_PAIR;
  if (raw.toLowerCase() === "usdg") return ADDRESSES.usdg;
  if (raw.toLowerCase() === "weth") return ADDRESSES.weth;
  return asAddress(raw, "--pair");
}

async function cmdStatus(): Promise<void> {
  const cfg = loadAppConfig();
  const { publicClient, account } = createClients(cfg, cfg.masterKey);
  await assertRobinhood(publicClient);
  const launcher = account?.address ?? NATIVE_PAIR;
  const status = await readFactoryStatus(publicClient, cfg.factory, cfg.launchAndBuy, launcher);
  console.log(`Chain ${ROBINHOOD_CHAIN_ID}`);
  console.log(`RPC ${cfg.rpcUrl}`);
  console.log(`Factory ${addrLine(status.factory)}`);
  console.log(`Launch+buy ${addrLine(status.launchAndBuy)}`);
  console.log(`Launch fee ${fmtEth(status.launchFee)}`);
  console.log(`launchEnabled ${status.launchEnabled}`);
  console.log(`canLaunch ${status.canLaunch}${account ? ` (${account.address})` : ""}`);
  console.log(`Max creator tax ${status.maxCreatorTaxBps} bps`);
  for (const config of status.configs) {
    console.log(
      `Config ${config.id} supply=${fmtUnits(config.supply, 18, 0)} fee=${config.curveFeeBps}bps phantom=${fmtEth(config.phantomQuote)} grad=${fmtEth(config.graduationThreshold)} enabled=${config.enabled}`,
    );
  }
}

async function cmdWallets(sub: string, flags: Flags): Promise<void> {
  if (sub === "generate") {
    const count = flagInt(flags, "count", 0);
    const wallets = generateWallets(count);
    const out = flagString(flags, "out", "wallets.json");
    const path = saveWalletFile(out, wallets, ROBINHOOD_CHAIN_ID);
    console.log(`Wrote ${wallets.length} wallets to ${path}`);
    for (const wallet of wallets) console.log(wallet.address);
    console.log("Keep this file private. It is gitignored.");
    return;
  }

  const file = flagString(flags, "file", "wallets.json");
  const wallets = loadWalletFile(file);
  if (wallets.length > MAX_EXEMPTIONS) {
    throw new Error(`File has ${wallets.length} wallets; v2 allows ${MAX_EXEMPTIONS} exemptions`);
  }

  if (sub === "list") {
    const cfg = loadAppConfig();
    const { publicClient } = createClients(cfg);
    const balances = await walletBalances(publicClient, wallets);
    for (const row of balances) {
      console.log(`${row.address} ${fmtEth(row.eth)}`);
    }
    return;
  }

  const cfg = loadAppConfig();
  const key = requireMasterKey(cfg);
  const { publicClient, account, chain } = createClients(cfg, key);
  if (!account) throw new Error("Master account missing");
  await assertRobinhood(publicClient);

  if (sub === "fund") {
    const each = parseEther(flagString(flags, "each"));
    const results = await fundWallets({
      publicClient,
      rpcUrl: cfg.rpcUrl,
      chain,
      master: account,
      wallets,
      each,
    });
    for (const row of results) {
      console.log(`${row.address} ${row.hash ? txLine(row.hash) : row.error}`);
    }
    return;
  }

  if (sub === "sweep") {
    const results = await sweepWallets({
      publicClient,
      rpcUrl: cfg.rpcUrl,
      chain,
      destination: account.address,
      wallets,
    });
    for (const row of results) {
      const extra = row.amount !== undefined ? ` ${fmtEth(row.amount)}` : "";
      console.log(`${row.address}${extra} ${row.hash ? txLine(row.hash) : row.error}`);
    }
    return;
  }

  throw new Error(`Unknown wallets command: ${sub}`);
}

function launchPlanFromFlags(flags: Flags, master: Address, exemptions: Address[]): LaunchPlan {
  const eachBuyRaw = flagOptional(flags, "each-buy");
  const eachBuy = eachBuyRaw ? parseEther(eachBuyRaw) : 0n;
  return {
    name: flagString(flags, "name"),
    symbol: flagString(flags, "symbol"),
    logo: flagOptional(flags, "logo") ?? "",
    description: flagOptional(flags, "description") ?? "",
    twitter: flagOptional(flags, "twitter") ?? "",
    telegram: flagOptional(flags, "telegram") ?? "",
    discord: flagOptional(flags, "discord") ?? "",
    website: flagOptional(flags, "website") ?? "",
    farcaster: flagOptional(flags, "farcaster") ?? "",
    launchConfigId: BigInt(flagInt(flags, "config-id", 0)),
    pairToken: parsePair(flags),
    creatorFeeRecipient: asAddress(flagOptional(flags, "fee-wallet") ?? master, "--fee-wallet"),
    creatorTaxBps: flagInt(flags, "creator-tax", 0),
    buybackEnabled: !flagBool(flags, "no-buyback"),
    masterBuy: parseEther(flagString(flags, "master-buy", "0")),
    walletBuys: exemptions.map(() => eachBuy),
    exemptions,
    recipient: asAddress(flagOptional(flags, "recipient") ?? master, "--recipient"),
    slippageBps: BigInt(flagInt(flags, "slippage", 800)),
  };
}

async function cmdLaunch(flags: Flags): Promise<void> {
  const cfg = loadAppConfig();
  const key = requireMasterKey(cfg);
  const { publicClient, walletClient, account, chain } = createClients(cfg, key);
  if (!account) throw new Error("Master account missing");
  await assertRobinhood(publicClient);

  const file = flagOptional(flags, "file");
  const wallets = file ? loadWalletFile(file) : [];
  if (wallets.length > MAX_EXEMPTIONS) {
    throw new Error(`At most ${MAX_EXEMPTIONS} exemption wallets`);
  }
  const plan = launchPlanFromFlags(
    flags,
    account.address,
    wallets.map((w) => w.address),
  );
  if (plan.masterBuy <= 0n) throw new Error("--master-buy must be > 0 for launchAndBuy");

  const prepared = await prepareLaunch({
    publicClient,
    factory: cfg.factory,
    launchAndBuy: cfg.launchAndBuy,
    account: account.address,
    plan,
  });

  const walletCost = plan.walletBuys.reduce((sum, n) => sum + n, 0n);
  console.log(`Token ${plan.name} (${plan.symbol})`);
  console.log(`Pair ${plan.pairToken === NATIVE_PAIR ? "native ETH" : plan.pairToken}`);
  console.log(`Launch fee ${fmtEth(prepared.launchFee)}`);
  console.log(`Master buy ${fmtEth(plan.masterBuy)} → ~${fmtUnits(prepared.masterQuote.tokensOut)} tokens`);
  console.log(`Wallet buys ${wallets.length} × ${fmtEth(plan.walletBuys[0] ?? 0n)} (${fmtEth(walletCost)} total)`);
  console.log(`Exemptions ${plan.exemptions.length}`);
  console.log(`Value sent ${fmtEth(prepared.value)}`);
  console.log(`minTokensOut ${fmtUnits(prepared.minTokensOut)}`);

  await simulateLaunch({ publicClient, account: account.address, prepared });
  console.log("Simulation launchAndBuy ok");

  if (flagBool(flags, "dry-run")) {
    console.log("Dry run not broadcast");
    return;
  }

  const launched = await sendLaunch({
    publicClient,
    walletClient,
    account,
    chain,
    prepared,
  });
  console.log(`Launch tx ${txLine(launched.hash)}`);
  console.log(`Token ${addrLine(launched.token)}`);
  console.log(`Curve ${addrLine(launched.curve)}`);
  console.log(`Seed tokens ${fmtUnits(launched.tokensOut)}`);
  console.log(`Pons https://www.ponsfamily.com/launchpad/${launched.token}`);

  if (wallets.length === 0 || (plan.walletBuys[0] ?? 0n) === 0n) return;

  console.log("Submitting exempt wallet buys…");
  const buys = await sendCurveBuys({
    publicClient,
    rpcUrl: cfg.rpcUrl,
    chain,
    curve: launched.curve,
    wallets,
    amounts: plan.walletBuys,
    slippageBps: plan.slippageBps,
  });
  for (const row of buys) {
    const extra = row.tokensOut !== undefined ? ` ${fmtUnits(row.tokensOut)} tokens` : "";
    console.log(`${row.address}${extra} ${row.hash ? txLine(row.hash) : row.error}`);
  }
}

async function cmdBuy(flags: Flags): Promise<void> {
  const cfg = loadAppConfig();
  const { publicClient, chain } = createClients(cfg);
  await assertRobinhood(publicClient);
  const token = asAddress(flagString(flags, "token"), "--token");
  const wallets = loadWalletFile(flagString(flags, "file", "wallets.json"));
  const each = parseEther(flagString(flags, "each-buy"));
  const slippageBps = BigInt(flagInt(flags, "slippage", 800));
  const { curve } = await resolveCurve(publicClient, cfg.factory, token);
  const buys = await sendCurveBuys({
    publicClient,
    rpcUrl: cfg.rpcUrl,
    chain,
    curve,
    wallets,
    amounts: wallets.map(() => each),
    slippageBps,
  });
  for (const row of buys) {
    const extra = row.tokensOut !== undefined ? ` ${fmtUnits(row.tokensOut)} tokens` : "";
    console.log(`${row.address}${extra} ${row.hash ? txLine(row.hash) : row.error}`);
  }
}

async function cmdSell(flags: Flags): Promise<void> {
  const cfg = loadAppConfig();
  const { publicClient, chain } = createClients(cfg);
  await assertRobinhood(publicClient);
  const token = asAddress(flagString(flags, "token"), "--token");
  const wallets = loadWalletFile(flagString(flags, "file", "wallets.json"));
  const percent = flagInt(flags, "percent", 100);
  if (percent < 1 || percent > 100) throw new Error("--percent must be 1-100");
  const slippageBps = BigInt(flagInt(flags, "slippage", 800));
  const { curve } = await resolveCurve(publicClient, cfg.factory, token);

  for (const wallet of wallets) {
    const account = privateKeyToAccount(wallet.privateKey);
    const { createWalletClient, http } = await import("viem");
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(cfg.rpcUrl),
    });
    try {
      const sold = await sellPercent({
        publicClient,
        walletClient,
        account,
        chain,
        curve,
        token,
        percentBps: BigInt(percent) * 100n,
        slippageBps,
      });
      console.log(`${wallet.address} sold ${fmtUnits(sold.tokensIn)} ${txLine(sold.hash)}`);
    } catch (error) {
      console.log(`${wallet.address} ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    console.log(help());
    return;
  }
  if (argv[0] === "sniper") {
    await cmdSniper(argv.slice(1));
    return;
  }
  if (argv[0] === "wallets") {
    const { flags } = parseArgs(argv.slice(1));
    const sub = argv[1];
    if (!sub || sub.startsWith("--")) throw new Error("Usage: wallets generate|list|fund|sweep");
    await cmdWallets(sub, flags);
    return;
  }
  const { command, flags } = parseArgs(argv);
  if (command === "status") await cmdStatus();
  else if (command === "launch") await cmdLaunch(flags);
  else if (command === "buy") await cmdBuy(flags);
  else if (command === "sell") await cmdSell(flags);
  else throw new Error(`Unknown command: ${command}\n${help()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
