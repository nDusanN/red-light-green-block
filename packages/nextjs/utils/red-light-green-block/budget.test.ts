import {
  ASSUMED_DECLINE_RATE,
  FAUCET_MON_PER_WALLET_PER_DAY,
  INITIAL_FUNDED_STEPS,
  MEASURED_GAS_PRICE_WEI,
  burnersFundable,
  estimateBudget,
  oneFullRunGas,
  sessionGas,
  targetBurnerBalanceWei,
  topUpAmountWei,
} from "./budget.ts";
import { JOIN_GAS_LIMIT, STEP_GAS_LIMIT, WINNING_STEP_GAS_LIMIT } from "./gas.ts";
import { TRACK_LENGTH } from "./light.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the funding model.
 *
 * The binding constraint on this project is the faucet, not the chain, so the arithmetic that
 * decides how many people can play is worth testing properly. In particular the top-up guard has
 * to actually refuse: a player who reloads the page repeatedly must not be able to drain the hot
 * wallet, because that would take everyone else's turn away.
 */

test("one full run is join plus a full track, with the winning step priced correctly", () => {
  const expected = JOIN_GAS_LIMIT + BigInt(TRACK_LENGTH - 1) * STEP_GAS_LIMIT + WINNING_STEP_GAS_LIMIT;
  assert.equal(oneFullRunGas(), expected);
  // The winning step really is the expensive one; if this stops holding, the client's decision to
  // raise its limit near the finish is pointless.
  assert.ok(WINNING_STEP_GAS_LIMIT > STEP_GAS_LIMIT);
});

test("worst case exceeds expected, and both scale with the field", () => {
  const ten = estimateBudget({ players: 10 });
  const fifty = estimateBudget({ players: 50 });

  assert.ok(ten.worstCaseMon > ten.expectedMon, "worst case must exceed the expected case");
  assert.ok(fifty.worstCaseMon > ten.worstCaseMon);
  // Linear in players: no shared per-round cost is being amortised away.
  assert.ok(Math.abs(fifty.worstCaseMon / ten.worstCaseMon - 5) < 0.001);
});

test("declaring measured limits genuinely costs less than a 1.5x wallet default", () => {
  const b = estimateBudget({ players: 50 });
  assert.ok(b.naiveWorstCaseMon > b.worstCaseMon, "the comparison must favour measuring");
  assert.ok(b.savedVsNaiveMon > 0);
  // Reported as a real proportion rather than a slogan.
  const savedPct = (1 - b.worstCaseMon / b.naiveWorstCaseMon) * 100;
  assert.ok(savedPct > 15 && savedPct < 40, `saving of ${savedPct.toFixed(1)}% looks wrong`);
});

test("the shorter track is what makes the demo fundable", () => {
  const short = estimateBudget({ players: 50, trackLength: 20 });
  const long = estimateBudget({ players: 50, trackLength: 100 });

  assert.ok(long.worstCaseMon > short.worstCaseMon * 4, "a 100-step track should cost several times more");
  // The point of the change: 20 steps is within reach of a few faucet claims, 100 is not.
  assert.ok(short.faucetWalletDaysWorstCase <= 6);
  assert.ok(long.faucetWalletDaysWorstCase > 20);
});

test("faucet wallet-days follow from the 1 MON per wallet per day limit", () => {
  const b = estimateBudget({ players: 50 });
  assert.equal(FAUCET_MON_PER_WALLET_PER_DAY, 1);
  assert.equal(b.faucetWalletDaysWorstCase, Math.ceil(b.worstCaseMon));
  assert.equal(b.faucetWalletDaysExpected, Math.ceil(b.expectedMon));
});

test("gas price feeds straight through", () => {
  const base = estimateBudget({ players: 10, gasPriceWei: MEASURED_GAS_PRICE_WEI });
  const double = estimateBudget({ players: 10, gasPriceWei: MEASURED_GAS_PRICE_WEI * 2n });
  assert.ok(Math.abs(double.worstCaseMon / base.worstCaseMon - 2) < 0.001);
});

test("the decline-rate assumption is declared, not hidden", () => {
  // It is a modelling assumption and must stay visible as one.
  assert.ok(ASSUMED_DECLINE_RATE > 0 && ASSUMED_DECLINE_RATE < 1);
  // The worst case must not depend on it: a pessimistic number that relies on an optimistic
  // assumption is not a pessimistic number.
  const a = estimateBudget({ players: 10, meanCompletionFraction: 0.1 });
  const b = estimateBudget({ players: 10, meanCompletionFraction: 0.9 });
  assert.equal(a.worstCaseMon, b.worstCaseMon);
  assert.ok(b.expectedMon > a.expectedMon);
});

test("top-up refuses a wallet that is already funded", () => {
  const target = targetBurnerBalanceWei();

  // Full, and comfortably above the threshold: send nothing.
  assert.equal(topUpAmountWei({ currentBalanceWei: target, targetWei: target }), 0n);
  assert.equal(topUpAmountWei({ currentBalanceWei: (target * 60n) / 100n, targetWei: target }), 0n);
  // Exactly at the threshold counts as funded.
  assert.equal(topUpAmountWei({ currentBalanceWei: target / 2n, targetWei: target }), 0n);
});

test("top-up fills to the target when genuinely low", () => {
  const target = targetBurnerBalanceWei();

  assert.equal(topUpAmountWei({ currentBalanceWei: 0n, targetWei: target }), target);

  const low = (target * 20n) / 100n;
  const amount = topUpAmountWei({ currentBalanceWei: low, targetWei: target });
  assert.equal(amount, target - low);
  assert.equal(low + amount, target, "a top-up must land exactly on the target, never above it");
});

test("a burner is funded for a realistic session, not a full run", () => {
  const target = targetBurnerBalanceWei();
  const sessionCost = sessionGas(INITIAL_FUNDED_STEPS) * MEASURED_GAS_PRICE_WEI;
  const fullRunCost = oneFullRunGas() * MEASURED_GAS_PRICE_WEI;

  assert.equal(target, sessionCost, "the drip must be exactly a funded session");
  // The decisive property: funding a realistic session rather than a full track is what multiplies
  // how many people can play from a fixed amount of MON.
  assert.ok(target < fullRunCost, "must not provision every player for the whole track");
  assert.ok(fullRunCost > target * 2n, "a full run should be several times a funded session");
});

test("burnersFundable reports what a hot wallet can actually serve", () => {
  const target = targetBurnerBalanceWei();
  const oneMon = 10n ** 18n;

  const fromOne = burnersFundable(oneMon, target);
  assert.ok(fromOne >= 18 && fromOne <= 30, `1 MON funding ${fromOne} burners looks wrong`);
  // Roughly linear, but not exactly: this is integer division, so five times the balance funds at
  // least five times as many burners and usually one or two more from the accumulated remainders.
  const fromFive = burnersFundable(oneMon * 5n, target);
  assert.ok(fromFive >= fromOne * 5, `${fromFive} should be at least ${fromOne * 5}`);
  assert.ok(fromFive <= fromOne * 5 + 5);
  assert.equal(burnersFundable(0n, target), 0);
});

test("a 50-player room needs a hot wallet planned in advance, not topped up on the day", () => {
  const target = targetBurnerBalanceWei();
  const needed = burnersFundable(10n ** 18n, target);
  // This is the number that has to be in the README: one faucet claim does not cover a room.
  assert.ok(needed < 50, "if one claim covered 50 players there would be no constraint to document");
});
