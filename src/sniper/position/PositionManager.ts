import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { erc20Abi } from "../../abi.js";
import { atomicWriteJson, readJsonOr } from "../persist.js";
import type { Position } from "../types.js";

type StoredPosition = Omit<Position, "amountBought" | "entryAmount"> & {
  amountBought: string;
  entryAmount: string;
};

export class PositionManager {
  private positions = new Map<string, Position>();

  constructor(
    private readonly path: string,
    private readonly client?: PublicClient,
  ) {
    this.load();
  }

  private load(): void {
    const stored = readJsonOr<{ positions: StoredPosition[] }>(this.path, { positions: [] });
    for (const item of stored.positions ?? []) {
      this.positions.set(item.id, {
        ...item,
        amountBought: BigInt(item.amountBought),
        entryAmount: BigInt(item.entryAmount),
      });
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, {
      positions: [...this.positions.values()].map((p) => ({
        ...p,
        amountBought: p.amountBought.toString(),
        entryAmount: p.entryAmount.toString(),
      })),
    });
  }

  open(input: {
    opportunityId: string;
    tokenAddress: Address;
    curveAddress: Address;
    walletAddress: Address;
    amountBought: bigint;
    entryAmount: bigint;
    entryTxHash: Hex;
  }): Position {
    const id = `${input.opportunityId}:${getAddress(input.walletAddress)}`;
    const position: Position = {
      id,
      opportunityId: input.opportunityId,
      tokenAddress: getAddress(input.tokenAddress),
      curveAddress: getAddress(input.curveAddress),
      walletAddress: getAddress(input.walletAddress),
      amountBought: input.amountBought,
      entryAmount: input.entryAmount,
      entryTxHash: input.entryTxHash,
      openedAt: Date.now(),
      status: "OPEN",
    };
    this.positions.set(id, position);
    this.persist();
    return position;
  }

  get(id: string): Position | undefined {
    return this.positions.get(id);
  }

  update(id: string, patch: Partial<Position>): Position {
    const current = this.positions.get(id);
    if (!current) throw new Error(`Unknown position ${id}`);
    const next = { ...current, ...patch, id };
    this.positions.set(id, next);
    this.persist();
    return next;
  }

  hasOpenPosition(tokenAddress: Address, walletAddress?: Address): boolean {
    const token = getAddress(tokenAddress);
    const wallet = walletAddress ? getAddress(walletAddress) : undefined;
    return [...this.positions.values()].some(
      (p) =>
        (p.status === "OPEN" || p.status === "UNKNOWN") &&
        getAddress(p.tokenAddress) === token &&
        (wallet === undefined || getAddress(p.walletAddress) === wallet),
    );
  }

  openPositions(): Position[] {
    return [...this.positions.values()].filter((p) => p.status === "OPEN" || p.status === "UNKNOWN");
  }

  all(): Position[] {
    return [...this.positions.values()];
  }

  entriesSince(sinceMs: number): Position[] {
    return [...this.positions.values()].filter((p) => p.openedAt >= sinceMs);
  }

  async reconcileBalance(position: Position): Promise<Position> {
    if (!this.client) return position;
    const balance = await this.client.readContract({
      address: position.tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [position.walletAddress],
    });
    const status = balance === 0n ? "CLOSED" : "OPEN";
    return this.update(position.id, { amountBought: balance, status });
  }
}
