export const BPS = 10_000n;

export type CurveSnapshot = {
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellable: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  snipeBps: bigint;
};

export type BuyQuote = {
  tokensOut: bigint;
  spent: bigint;
  refund: bigint;
  netIn: bigint;
  fee: bigint;
  tax: bigint;
  snipeTax: bigint;
  snipeBps: bigint;
};

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("division by zero");
  return (a + b - 1n) / b;
}

/** Constant product in the curve's documented integer order. Fees stay outside this step. */
export function amountOut(inAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (inAmount <= 0n) return 0n;
  return (inAmount * reserveOut) / (reserveIn + inAmount);
}

export function amountIn(outAmount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (outAmount <= 0n) return 0n;
  if (outAmount >= reserveOut) throw new Error("output exceeds reserve");
  return (outAmount * reserveIn) / (reserveOut - outAmount) + 1n;
}

export function applySlippage(amount: bigint, slippageBps: bigint): bigint {
  if (slippageBps >= BPS) return 0n;
  return (amount * (BPS - slippageBps)) / BPS;
}

export function reservedTokens(supply: bigint, phantomQuote: bigint, threshold: bigint): bigint {
  if (phantomQuote + threshold === 0n) return 0n;
  return (supply * phantomQuote) / (phantomQuote + threshold);
}

export function sellableFromConfig(supply: bigint, phantomQuote: bigint, threshold: bigint): bigint {
  return supply - reservedTokens(supply, phantomQuote, threshold);
}

export function snapshotFromConfig(input: {
  supply: bigint;
  phantomQuote: bigint;
  threshold: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  snipeBps?: bigint;
}): CurveSnapshot {
  return {
    quoteReserve: input.phantomQuote,
    tokenReserve: input.supply,
    sellable: sellableFromConfig(input.supply, input.phantomQuote, input.threshold),
    feeBps: input.feeBps,
    creatorTaxBps: input.creatorTaxBps,
    snipeBps: input.snipeBps ?? 0n,
  };
}

export function quoteBuy(quoteIn: bigint, snap: CurveSnapshot): BuyQuote {
  if (quoteIn <= 0n) {
    return {
      tokensOut: 0n,
      spent: 0n,
      refund: 0n,
      netIn: 0n,
      fee: 0n,
      tax: 0n,
      snipeTax: 0n,
      snipeBps: 0n,
    };
  }

  let snipeBps = snap.snipeBps;
  if (snipeBps > 0n) {
    const maxSnipeBps = BPS - snap.feeBps - snap.creatorTaxBps - 100n;
    if (snipeBps > maxSnipeBps) snipeBps = maxSnipeBps < 0n ? 0n : maxSnipeBps;
  }

  let spent = quoteIn;
  const fee = (spent * snap.feeBps) / BPS;
  const tax = (spent * snap.creatorTaxBps) / BPS;
  const snipeTax = (spent * snipeBps) / BPS;
  let netIn = spent - fee - tax - snipeTax;
  let tokensOut = amountOut(netIn, snap.quoteReserve, snap.tokenReserve);

  if (tokensOut > snap.sellable) {
    tokensOut = snap.sellable;
    const net = amountIn(snap.sellable, snap.quoteReserve, snap.tokenReserve);
    const denom = BPS - snap.feeBps - snap.creatorTaxBps - snipeBps;
    const grossed = denom === 0n ? quoteIn : ceilDiv(net * BPS, denom);
    spent = grossed < quoteIn ? grossed : quoteIn;
    netIn = net;
  }

  return {
    tokensOut,
    spent,
    refund: quoteIn - spent,
    netIn,
    fee: (spent * snap.feeBps) / BPS,
    tax: (spent * snap.creatorTaxBps) / BPS,
    snipeTax: (spent * snipeBps) / BPS,
    snipeBps,
  };
}

export function applyBuy(snap: CurveSnapshot, quote: BuyQuote): CurveSnapshot {
  return {
    ...snap,
    quoteReserve: snap.quoteReserve + quote.netIn,
    tokenReserve: snap.tokenReserve - quote.tokensOut,
    sellable: snap.sellable - quote.tokensOut,
  };
}

export function quoteBuySequence(quoteIns: bigint[], start: CurveSnapshot): BuyQuote[] {
  const out: BuyQuote[] = [];
  let snap = start;
  for (const quoteIn of quoteIns) {
    const quoted = quoteBuy(quoteIn, snap);
    out.push(quoted);
    snap = applyBuy(snap, quoted);
  }
  return out;
}
