import { applySlippage, BPS, quoteBuy, type CurveSnapshot } from "../../quote.js";
import type { SniperBuyQuote } from "../types.js";

export class PonsQuoteEngine {
  quoteBuy(amountIn: bigint, snapshot: CurveSnapshot, slippageBps: number): SniperBuyQuote {
    if (slippageBps < 0 || slippageBps >= Number(BPS)) {
      throw new Error(`Invalid slippage ${slippageBps} bps`);
    }
    const quoted = quoteBuy(amountIn, snapshot);
    const minTokensOut = applySlippage(quoted.tokensOut, BigInt(slippageBps));
    const priceImpactBps = priceImpact(snapshot, quoted.netIn, quoted.tokensOut);
    return {
      amountIn,
      expectedTokensOut: quoted.tokensOut,
      minTokensOut,
      spent: quoted.spent,
      refund: quoted.refund,
      fee: quoted.fee,
      tax: quoted.tax,
      snipeTax: quoted.snipeTax,
      snipeBps: quoted.snipeBps,
      priceImpactBps,
    };
  }
}

function priceImpact(snapshot: CurveSnapshot, netIn: bigint, tokensOut: bigint): number | undefined {
  if (netIn <= 0n || tokensOut <= 0n || snapshot.quoteReserve === 0n || snapshot.tokenReserve === 0n) {
    return undefined;
  }
  const spotOut = (netIn * snapshot.tokenReserve) / snapshot.quoteReserve;
  if (spotOut === 0n) return undefined;
  if (tokensOut >= spotOut) return 0;
  const impact = ((spotOut - tokensOut) * BPS) / spotOut;
  return Number(impact);
}
