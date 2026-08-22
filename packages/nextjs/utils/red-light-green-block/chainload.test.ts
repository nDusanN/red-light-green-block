import { type ChainBaseline, combineLoad, loadMultiple } from "./chainload.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A real sample, taken from Monad testnet: 19 blocks, read straight off the chain.
 *
 * The block gas limit here is read from the block rather than assumed. It is 150,000,000 — an
 * earlier estimate of 45,000,000 would have overstated how full blocks are by more than 3x, and
 * the whole point of this figure is to keep the pitch from overclaiming.
 */
const baseline: ChainBaseline = {
  sampleSize: 19,
  minTxPerBlock: 1,
  medianTxPerBlock: 3,
  maxTxPerBlock: 6,
  meanTxPerBlock: 3.68,
  meanFillPercent: 0.61,
  meanGasUsed: 913_605,
  gasLimit: 150_000_000,
  sampledAt: 0,
};

test("combineLoad splits a block into our moves and everyone else's", () => {
  const load = combineLoad(100n, { totalTx: 53, fillPercent: 8.2 }, 50);
  assert.equal(load.totalTx, 53);
  assert.equal(load.gameMoves, 50);
  assert.equal(load.otherTx, 3);
});

test("otherTx never goes negative", () => {
  // Our log count can exceed the block's transaction count if a transaction emitted more than one
  // event. A negative "everyone else" would be visibly absurd on screen.
  const load = combineLoad(100n, { totalTx: 2, fillPercent: 1 }, 5);
  assert.equal(load.otherTx, 0);
});

test("loadMultiple reports the multiple over the measured baseline", () => {
  // 50 of our moves on top of a 3.4 tx/block baseline is (50 + 3.4) / 3.4.
  const multiple = loadMultiple(50, baseline);
  assert.ok(multiple !== undefined);
  // (50 + 3.68) / 3.68
  assert.ok(Math.abs(multiple - 14.6) < 0.2, `expected ~14.6x, got ${multiple}`);
});

test("an unmeasurable multiple is undefined, never a confident zero", () => {
  // A projector showing "0x" or "Infinityx" would be worse than showing nothing.
  assert.equal(loadMultiple(50, undefined), undefined);
  assert.equal(loadMultiple(0, baseline), undefined);
  assert.equal(loadMultiple(50, { ...baseline, meanTxPerBlock: 0 }), undefined);
});

test("the honest half of the claim: a big multiple can still be a tiny fraction of a block", () => {
  // This is the guard against the pitch overclaiming. 50 players is a large multiple of the
  // testnet's traffic AND a small fraction of one block's capacity. Both must be true at once.
  const multiple = loadMultiple(50, baseline)!;
  assert.ok(multiple > 10, "50 players should be a large multiple of a near-idle testnet");

  // 50 steps at the declared limit, against the real 150M block gas limit.
  const gasForFiftySteps = 50 * 52_030;
  const fill = ((baseline.meanGasUsed + gasForFiftySteps) / baseline.gasLimit) * 100;
  assert.ok(fill < 5, `a full room should still be a few percent of a block, got ${fill.toFixed(2)}%`);
});

test("baseline carries its sample size so the figure can be weighed", () => {
  // A measured number quoted without its sample size is halfway to being an invented one.
  assert.ok(baseline.sampleSize > 0);
  assert.ok(baseline.minTxPerBlock <= baseline.medianTxPerBlock);
  assert.ok(baseline.medianTxPerBlock <= baseline.maxTxPerBlock);
});
