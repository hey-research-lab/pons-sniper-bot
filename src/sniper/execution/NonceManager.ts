import type { Address, PublicClient } from "viem";

type Gate = {
  chain: Promise<void>;
  next?: number;
};

export class NonceManager {
  private gates = new Map<string, Gate>();

  constructor(private readonly client: PublicClient) {}

  async allocate(address: Address): Promise<number> {
    const key = address.toLowerCase();
    const gate = this.gates.get(key) ?? { chain: Promise.resolve() };
    let release!: () => void;
    const previous = gate.chain;
    gate.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(key, gate);
    await previous;
    try {
      const pending = await this.client.getTransactionCount({ address, blockTag: "pending" });
      const nonce = gate.next !== undefined && gate.next > pending ? gate.next : pending;
      gate.next = nonce + 1;
      return nonce;
    } finally {
      release();
    }
  }

  peek(address: Address): number | undefined {
    return this.gates.get(address.toLowerCase())?.next;
  }
}
