import { getAddress, type Address } from "viem";
import { atomicWriteJson, readJsonOr } from "../persist.js";
import type { PonsOpportunity } from "../types.js";

type StoredOpportunity = Omit<
  PonsOpportunity,
  "launchConfigId" | "graduationThreshold" | "initialLiquidity"
> & {
  launchConfigId?: string;
  graduationThreshold?: string;
  initialLiquidity?: string;
};

export class OpportunityRegistry {
  private memory = new Map<string, PonsOpportunity>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    const stored = readJsonOr<{ opportunities: StoredOpportunity[] }>(this.path, { opportunities: [] });
    for (const item of stored.opportunities ?? []) {
      this.memory.set(item.id, reviveOpportunity(item));
    }
  }

  private persist(): void {
    atomicWriteJson(this.path, {
      opportunities: [...this.memory.values()].map(serializeOpportunity),
    });
  }

  has(id: string): boolean {
    return this.memory.has(id);
  }

  add(opportunity: PonsOpportunity): void {
    this.memory.set(opportunity.id, opportunity);
    this.persist();
  }

  get(id: string): PonsOpportunity | undefined {
    return this.memory.get(id);
  }

  hasToken(token: Address): boolean {
    const needle = getAddress(token);
    for (const opp of this.memory.values()) {
      if (getAddress(opp.tokenAddress) === needle) return true;
    }
    return false;
  }

  size(): number {
    return this.memory.size;
  }
}

function serializeOpportunity(opportunity: PonsOpportunity): StoredOpportunity {
  return {
    ...opportunity,
    launchConfigId: opportunity.launchConfigId?.toString(),
    graduationThreshold: opportunity.graduationThreshold?.toString(),
    initialLiquidity: opportunity.initialLiquidity?.toString(),
  };
}

function reviveOpportunity(stored: StoredOpportunity): PonsOpportunity {
  return {
    ...stored,
    launchConfigId: stored.launchConfigId ? BigInt(stored.launchConfigId) : undefined,
    graduationThreshold: stored.graduationThreshold ? BigInt(stored.graduationThreshold) : undefined,
    initialLiquidity: stored.initialLiquidity ? BigInt(stored.initialLiquidity) : undefined,
  };
}
