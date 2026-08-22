import {
  JOIN_GAS_LIMIT,
  MEASURED_STEP_MISSED_WINDOW_GAS,
  NAIVE_STEP_GAS_LIMIT,
  STEP_GAS_LIMIT,
  WINNING_STEP_GAS_LIMIT,
} from "./gas.ts";
import { TRACK_LENGTH } from "./light.ts";

/**
 * What it costs to run a game, in MON.
 *
 * This exists because the binding constraint on this project is not Monad and not the contract —
 * it is the faucet. The official faucet dispenses 1 MON per wallet per day and there is no larger
 * public source, so the budget decides how many people can play, and it has to be computed from
 * measured gas rather than guessed at.
 *
 * Every figure here is derived from the measured limits in `gas.ts` and a gas price the caller
 * supplies from a live `eth_gasPrice`. Nothing is hardcoded from memory.
 */

/** Monad testnet base fee observed at 100 gwei; `eth_gasPrice` returned 102 gwei when measured. */
export const MEASURED_GAS_PRICE_WEI = 102_000_000_000n;

/** What the official faucet at https://faucet.monad.xyz gives per wallet per day. */
export const FAUCET_MON_PER_WALLET_PER_DAY = 1;

const WEI_PER_MON = 10n ** 18n;

/**
 * Fraction of a player's taps that are expected to be declined steps rather than real ones.
 *
 * A declined step still pays the intrinsic cost, so it is not free, but at 1,710 gas of execution
 * it is far cheaper than a real step. This is a MODELLING ASSUMPTION, not a measurement — it is
 * labelled as such everywhere it surfaces, and the worst-case figures below assume zero declines
 * so the pessimistic number never depends on it.
 */
export const ASSUMED_DECLINE_RATE = 0.25;

export type BudgetInputs = {
  players: number;
  /** Gas price in wei, from a live `eth_gasPrice`. */
  gasPriceWei?: bigint;
  /** Steps to win. Defaults to the contract's track length. */
  trackLength?: number;
  /**
   * Mean fraction of the track a player completes before elimination.
   *
   * Defaults to 0.5. This is an ASSUMPTION about how far players get, not a measurement. With the
   * measured 52.3% green share and permanent elimination, most players die well before the finish,
   * so it is a deliberately conservative stand-in for a distribution we have not yet observed. The
   * load test is what will replace it with a real number.
   */
  meanCompletionFraction?: number;
};

export type BudgetResult = {
  /** Nobody declines a step and every player runs the full track. */
  worstCaseMon: number;
  /** Uses the completion and decline assumptions above. Clearly not a guarantee. */
  expectedMon: number;
  /** What the same game would cost with a wallet's habitual 1.5x-on-estimate default. */
  naiveWorstCaseMon: number;
  /** MON saved at worst case by declaring measured limits instead of the 1.5x default. */
  savedVsNaiveMon: number;
  /** Faucet wallet-days needed to fund the worst case, at 1 MON per wallet per day. */
  faucetWalletDaysWorstCase: number;
  /** Faucet wallet-days needed to fund the expected case. */
  faucetWalletDaysExpected: number;
};

function weiToMon(wei: bigint): number {
  // Numbers here are small enough that float is fine, and a float is what the UI wants anyway.
  return Number((wei * 1_000_000n) / WEI_PER_MON) / 1_000_000;
}

/**
 * Cost of running one round.
 *
 * Worst case assumes every player joins and completes the whole track with no declined steps —
 * which never happens, but is the number that must be affordable for the demo to be safe.
 */
export function estimateBudget({
  players,
  gasPriceWei = MEASURED_GAS_PRICE_WEI,
  trackLength = TRACK_LENGTH,
  meanCompletionFraction = 0.5,
}: BudgetInputs): BudgetResult {
  const playersBig = BigInt(players);
  const steps = BigInt(trackLength);

  // Worst case: every player joins, takes trackLength-1 ordinary steps and one winning step.
  const joinGas = playersBig * JOIN_GAS_LIMIT;
  const stepGas = playersBig * ((steps - 1n) * STEP_GAS_LIMIT + WINNING_STEP_GAS_LIMIT);
  const worstCaseWei = (joinGas + stepGas) * gasPriceWei;

  const naiveStepGas = playersBig * steps * NAIVE_STEP_GAS_LIMIT;
  const naiveWorstCaseWei = (joinGas + naiveStepGas) * gasPriceWei;

  // Expected case: players reach part of the track, and some taps are declined steps.
  const realSteps = Math.max(0, Math.round(trackLength * meanCompletionFraction));
  const declinedSteps = Math.round(realSteps * ASSUMED_DECLINE_RATE);
  const expectedPerPlayerGas =
    JOIN_GAS_LIMIT +
    BigInt(realSteps) * STEP_GAS_LIMIT +
    // A declined step still pays intrinsic + calldata; only its execution is cheap.
    BigInt(declinedSteps) * (21_000n + 576n + MEASURED_STEP_MISSED_WINDOW_GAS);
  const expectedWei = playersBig * expectedPerPlayerGas * gasPriceWei;

  const worstCaseMon = weiToMon(worstCaseWei);
  const expectedMon = weiToMon(expectedWei);
  const naiveWorstCaseMon = weiToMon(naiveWorstCaseWei);

  return {
    worstCaseMon,
    expectedMon,
    naiveWorstCaseMon,
    savedVsNaiveMon: naiveWorstCaseMon - worstCaseMon,
    faucetWalletDaysWorstCase: Math.ceil(worstCaseMon / FAUCET_MON_PER_WALLET_PER_DAY),
    faucetWalletDaysExpected: Math.ceil(expectedMon / FAUCET_MON_PER_WALLET_PER_DAY),
  };
}

/**
 * Gas for a realistic session: one join plus `steps` steps.
 *
 * This, not a full run, is what a burner is funded for. With the measured 52.3% green share and
 * permanent elimination, the median player dies in the first one or two red phases — provisioning
 * everyone for a full track means the hot wallet is drained by people who never needed it, and
 * every over-funded abandoned burner is someone later who cannot play at all.
 */
export function sessionGas(steps: number): bigint {
  return JOIN_GAS_LIMIT + BigInt(steps) * STEP_GAS_LIMIT;
}

/**
 * Gas needed for one guaranteed full run: join, then the whole track.
 *
 * A ceiling used for worst-case budgeting, NOT for sizing drips.
 */
export function oneFullRunGas(trackLength: number = TRACK_LENGTH): bigint {
  const steps = BigInt(trackLength);
  return JOIN_GAS_LIMIT + (steps - 1n) * STEP_GAS_LIMIT + WINNING_STEP_GAS_LIMIT;
}

/**
 * Steps a burner is initially funded for.
 *
 * 30 — a full 20-step track plus half again in margin.
 *
 * This was 8 while the hot wallet was expected to hold 2-3 MON, chosen against the elimination
 * curve so a fixed budget would stretch across the room. With 45 MON that constraint is gone, and
 * being stingy inverts from a saving into a liability: a player who exhausts their gas mid-race has
 * to hit the top-up path, and that is one more thing that can be slow or rate-limited at exactly
 * the moment the room is watching.
 *
 * Funding a whole run up front makes the top-up path a safety net rather than a load-bearing part
 * of the demo. At ~0.15 MON each, 45 MON still funds around 300 players -- far more than the room.
 */
export const INITIAL_FUNDED_STEPS = 30;

/**
 * The balance a burner is topped up TO.
 *
 * A target rather than a flat handout, and deliberately stingy. Derived from a live `eth_gasPrice`
 * where the caller supplies one, so it self-corrects if the base fee moves rather than silently
 * under-funding every wallet.
 */
export function targetBurnerBalanceWei({
  gasPriceWei = MEASURED_GAS_PRICE_WEI,
  steps = INITIAL_FUNDED_STEPS,
}: {
  gasPriceWei?: bigint;
  steps?: number;
} = {}): bigint {
  return sessionGas(steps) * gasPriceWei;
}

/**
 * How much to actually send a burner, given what it already holds.
 *
 * Returns 0 when the wallet is above `topUpThresholdFraction` of the target, so a player who
 * reloads the page repeatedly cannot drain the hot wallet by re-requesting funds.
 */
export function topUpAmountWei({
  currentBalanceWei,
  targetWei,
  topUpThresholdFraction = 0.5,
}: {
  currentBalanceWei: bigint;
  targetWei: bigint;
  topUpThresholdFraction?: number;
}): bigint {
  const threshold = (targetWei * BigInt(Math.round(topUpThresholdFraction * 100))) / 100n;
  if (currentBalanceWei >= threshold) return 0n;
  return targetWei - currentBalanceWei;
}

/** How many burners a hot wallet holding `balanceWei` can still fund from scratch. */
export function burnersFundable(balanceWei: bigint, targetWei: bigint): number {
  if (targetWei <= 0n) return 0;
  return Number(balanceWei / targetWei);
}
