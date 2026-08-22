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
  // The point of the change, stated as the ratio rather than as absolute MON: the absolute figures
  // move whenever gas prices or the live gas estimates change, but a 100-step track always costs
  // several times a 20-step one, and that is what made the demo fundable.
  assert.ok(long.faucetWalletDaysWorstCase > short.faucetWalletDaysWorstCase * 3);
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

test("a burner is funded for a whole run, so the top-up path is only a safety net", () => {
  const target = targetBurnerBalanceWei();
  const sessionCost = sessionGas(INITIAL_FUNDED_STEPS) * MEASURED_GAS_PRICE_WEI;
  const fullRunCost = oneFullRunGas() * MEASURED_GAS_PRICE_WEI;

  assert.equal(target, sessionCost, "the drip must be exactly a funded session");
  // The property that matters now that the budget is comfortable: a player must never need a
  // top-up mid-race. The top-up path is one more thing that can be slow or rate-limited at the
  // moment the room is watching, so it should be a safety net rather than load-bearing.
  assert.ok(target > fullRunCost, "a burner must be able to finish the track without a top-up");
  assert.ok(target < fullRunCost * 3n, "but not so much that an abandoned burner wastes a lot");
});

test("burnersFundable reports what a hot wallet can actually serve", () => {
  const target = targetBurnerBalanceWei();
  const oneMon = 10n ** 18n;

  const fromOne = burnersFundable(oneMon, target);
  assert.ok(fromOne >= 4 && fromOne <= 12, `1 MON funding ${fromOne} burners looks wrong`);
  // Roughly linear, but not exactly: this is integer division, so five times the balance funds at
  // least five times as many burners and usually one or two more from the accumulated remainders.
  const fromFive = burnersFundable(oneMon * 5n, target);
  assert.ok(fromFive >= fromOne * 5, `${fromFive} should be at least ${fromOne * 5}`);
  assert.ok(fromFive <= fromOne * 5 + 5);
  assert.equal(burnersFundable(0n, target), 0);
});

test("the funded hot wallet comfortably covers a full room", () => {
  const target = targetBurnerBalanceWei();
  // 45 MON was swept into the hot wallet after the deploy.
  const room = burnersFundable(45n * 10n ** 18n, target);
  assert.ok(room > 100, `45 MON should fund well over a room, got ${room}`);
  // And one faucet claim alone still does not, which is why the wallet has to be funded ahead of
  // time rather than on the day.
  assert.ok(burnersFundable(10n ** 18n, target) < 50);
});
