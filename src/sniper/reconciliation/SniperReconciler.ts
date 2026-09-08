import type { Address, PublicClient } from "viem";
import { erc20Abi } from "../../abi.js";
import { logEvent } from "../log.js";
import { PositionManager } from "../position/PositionManager.js";
import { ExecutionStore, isInFlightState } from "../state/ExecutionStore.js";
import type { ExecutionRecord, Position } from "../types.js";

export type ReconcileReport = {
  nativeBalance: bigint;
  inFlight: number;
  openPositions: number;
  updated: string[];
};

export class SniperReconciler {
  constructor(
    private readonly client: PublicClient,
    private readonly store: ExecutionStore,
    private readonly positions: PositionManager,
    private readonly wallet: Address,
  ) {}

  async reconcile(): Promise<ReconcileReport> {
    const nativeBalance = await this.client.getBalance({ address: this.wallet });
    const updated: string[] = [];

    for (const record of this.store.inFlight()) {
      const next = await this.reconcileExecution(record);
      if (next) updated.push(next.opportunityId);
    }

    for (const position of this.positions.all()) {
      const next = await this.reconcilePosition(position);
      if (next) updated.push(next.id);
    }

    logEvent("sniper.reconcile", {
      nativeBalance: nativeBalance.toString(),
      inFlight: this.store.inFlight().length,
      openPositions: this.positions.openPositions().length,
      updated,
    });

    return {
      nativeBalance,
      inFlight: this.store.inFlight().length,
      openPositions: this.positions.openPositions().length,
      updated,
    };
  }

  private async reconcileExecution(record: ExecutionRecord): Promise<ExecutionRecord | undefined> {
    if (!record.txHash) {
      if (isInFlightState(record.state)) {
        return this.store.transition(record.opportunityId, "UNKNOWN", {
          error: "Submitted or signed without a hash; refusing automatic resubmit",
          failureClass: "UNKNOWN",
        });
      }
      return undefined;
    }
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: record.txHash });
      if (receipt.status === "success") {
        const confirmed = this.store.transition(record.opportunityId, "CONFIRMED", { txHash: record.txHash });
        if (!this.positions.hasOpenPosition(record.tokenAddress, record.walletAddress)) {
          const balance = await this.client.readContract({
            address: record.tokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [record.walletAddress],
          });
          this.positions.open({
            opportunityId: record.opportunityId,
            tokenAddress: record.tokenAddress,
            curveAddress: record.curveAddress,
            walletAddress: record.walletAddress,
            amountBought: balance,
            entryAmount: BigInt(record.amountIn ?? "0"),
            entryTxHash: record.txHash,
          });
        }
        return confirmed;
      }
      return this.store.transition(record.opportunityId, "REVERTED", {
        txHash: record.txHash,
        error: "reverted",
        failureClass: "TX_REVERT",
      });
    } catch {
      const tx = await this.client.getTransaction({ hash: record.txHash }).catch(() => undefined);
      if (!tx) {
        return this.store.transition(record.opportunityId, "UNKNOWN", {
          txHash: record.txHash,
          error: "RPC timeout or missing receipt; not resubmitting",
          failureClass: "TRANSIENT_RPC",
        });
      }
      return this.store.transition(record.opportunityId, "PENDING", { txHash: record.txHash });
    }
  }

  private async reconcilePosition(position: Position): Promise<Position | undefined> {
    try {
      return await this.positions.reconcileBalance(position);
    } catch (error) {
      logEvent("sniper.reconcile.position_error", {
        positionId: position.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
