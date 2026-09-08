import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "viem";
import {
  applyBuy,
  amountOut,
  quoteBuy,
  quoteBuySequence,
  reservedTokens,
  snapshotFromConfig,
} from "./quote.js";

const supply = 1_000_000_000n * 10n ** 18n;
const phantom = parseEther("1.67");
const threshold = parseEther("4.2");

test("reserved + sellable split the supply", () => {
  const reserved = reservedTokens(supply, phantom, threshold);
  const start = snapshotFromConfig({
    supply,
    phantomQuote: phantom,
    threshold,
    feeBps: 100n,
    creatorTaxBps: 0n,
  });
  assert.equal(reserved + start.sellable, supply);
  assert.ok(start.sellable > 0n);
});

test("buy fees come off the input before constant product", () => {
  const start = snapshotFromConfig({
    supply,
    phantomQuote: phantom,
    threshold,
    feeBps: 100n,
    creatorTaxBps: 0n,
  });
  const quoteIn = parseEther("0.1");
  const quoted = quoteBuy(quoteIn, start);
  const net = quoteIn - quoteIn / 100n;
  const expected = amountOut(net, start.quoteReserve, start.tokenReserve);
  assert.equal(quoted.fee, quoteIn / 100n);
  assert.equal(quoted.tokensOut, expected);
  assert.equal(quoted.refund, 0n);
  assert.ok(quoted.tokensOut > 0n);
});

test("snipe tax is capped so the buyer still nets 1%", () => {
  const start = snapshotFromConfig({
    supply,
    phantomQuote: phantom,
    threshold,
    feeBps: 100n,
    creatorTaxBps: 0n,
    snipeBps: 9_900n,
  });
  const quoted = quoteBuy(parseEther("1"), start);
  assert.equal(quoted.snipeBps, 9_800n);
  assert.ok(quoted.netIn > 0n);
});

test("sequential bundle quotes move reserves", () => {
  const start = snapshotFromConfig({
    supply,
    phantomQuote: phantom,
    threshold,
    feeBps: 100n,
    creatorTaxBps: 0n,
  });
  const first = quoteBuy(parseEther("0.2"), start);
  const second = quoteBuySequence([parseEther("0.2")], applyBuy(start, first))[0];
  assert.ok(second);
  assert.ok(second.tokensOut < first.tokensOut);
});
