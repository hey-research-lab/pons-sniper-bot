import { defineChain, type Address, type Hex, zeroAddress } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const NATIVE_PAIR = zeroAddress;
export const MAX_EXEMPTIONS = 32;

export const ADDRESSES = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  launchAndBuy: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  launchDeployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42",
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
} as const satisfies Record<string, Address>;

export function explorerTx(hash: Hex): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAddress(address: Address): string {
  return `${EXPLORER}/address/${address}`;
}

export function robinhoodChain(rpcUrl: string) {
  return defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: { name: "Blockscout", url: EXPLORER },
    },
  });
}
