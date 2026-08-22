/**
 * Declared gas limits for Red Light, Green Block.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Monad charges for the gas limit a transaction DECLARES, not the gas it uses. The 1.5x buffer
 * most wallets apply by default is therefore not free here: it is gas the player pays for and
 * never consumes. In a game where every tap is a transaction and the whole budget comes from a
 * faucet that dispenses 1 MON per wallet per day, that difference decides how many people get to
 * play.
 *
 * So the limits below are derived from measured worst cases plus a small margin, never from an
 * estimate multiplied by a round number, and never from `eth_estimateGas` at runtime — that method
 * carries the tightest rate limit of any RPC call and is exactly what must be conserved.
 *
 * HOW THESE NUMBERS WERE OBTAINED
 * -------------------------------
 * Execution figures come from `test_MeasuredGasPerStepPath` in
 * `packages/foundry/test/RedLightGreenBlock.t.sol`, run with `forge test`. Each is measured with
 * `vm.cool()` first, because Foundry executes a whole test as a single transaction and would
 * otherwise report warm-slot costs that a real, standalone transaction never enjoys.
 *
 * These are EXECUTION gas only, as seen from inside the EVM. A real transaction also pays the
 * 21,000 intrinsic cost and for its calldata, both added explicitly below.
 *
 * THE FOUNDRY FIGURES WERE NOT ENOUGH, AND THIS IS THE IMPORTANT PART.
 *
 * Foundry said a fresh `join` costs 75,620 execution gas, which with intrinsic and calldata came to
 * a declared limit of 103,935. Live `eth_estimateGas` against the deployed contract returned
 * 118,819 — roughly 23% higher. Every join therefore ran out of gas and reverted, and because
 * Monad charges the DECLARED limit, each failure cost the player the full amount for nothing.
 *
 * The failure was thoroughly misleading downstream: joins reverted silently (viem's
 * `waitForTransactionReceipt` resolves happily on a reverted receipt), so every following `step`
 * failed with `NotJoined`, which surfaced as a large "missed window" count and sent me looking for
 * a step-timing bug that did not exist.
 *
 * So the declared limits below come from LIVE `eth_estimateGas` against the deployed contract, and
 * the Foundry numbers are kept only as a regression check on the contract itself. A local EVM
 * measurement is not a substitute for the real chain.
 *
 * Confirmed while measuring: a receipt's `gasUsed` comes back exactly equal to the declared limit.
 * Sending `join` with `gas = 2 * 118,819` produced `gasUsed = 237,638`. That is Monad's
 * charge-on-declared-limit model visible directly in a receipt, and it is why a loose limit is a
 * real cost rather than a harmless safety margin.
 */

/** Intrinsic cost every transaction pays before any code runs. */
export const INTRINSIC_TX_GAS = 21_000n;

/**
 * Margin applied on top of a measured worst case. 1.075x.
 *
 * This is not a number we invented. Category Labs' analysis of Monad mainnet
 * (https://www.category.xyz/blogs/setting-your-gas-limit-on-monad) found a fixed +7.5% buffer gave
 * "the largest consistent improvement (reduction) in transaction failure rate" while holding
 * unused gas at roughly 7-9%, and Monad's own wallet-developer guide recommends the same recipe.
 * We apply it to a measured worst case rather than to an `eth_estimateGas` result, so the input is
 * tighter than what the guidance assumes.
 */
export const GAS_LIMIT_MARGIN_BPS = 10_750n;

const BPS_DENOMINATOR = 10_000n;

function withMargin(gas: bigint): bigint {
  return (gas * GAS_LIMIT_MARGIN_BPS) / BPS_DENOMINATOR;
}

/* ------------------------------------------------------------------ *
 * Measured execution gas (forge test, cold storage, EVM-internal)
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * LIVE estimates from eth_estimateGas against the deployed contract.
 * These are what the declared limits are built from.
 * ------------------------------------------------------------------ */

/** Live estimate for an ordinary `step`, from a joined player. */
export const LIVE_STEP_GAS = 48_400n;

/** Live estimate for a fresh address joining. */
export const LIVE_JOIN_GAS = 118_819n;

/** Live estimate for `startRound`. */
export const LIVE_START_ROUND_GAS = 37_050n;

/**
 * Headroom for the winning step, which additionally writes `roundWinner` from zero.
 *
 * A fresh non-zero SSTORE is 20,000 gas; 24,000 is that plus slack. It cannot be estimated live
 * because estimating it requires a player already standing one step from the finish.
 */
export const WINNING_STEP_EXTRA_GAS = 24_000n;

/* ------------------------------------------------------------------ *
 * Foundry measurements — kept as a regression check on the contract.
 * ------------------------------------------------------------------ */

/** An ordinary green step that advances the player. */
export const MEASURED_STEP_GREEN_GAS = 17_544n;

/** A step that landed on red and eliminated the player. Slightly cheaper than advancing. */
export const MEASURED_STEP_RED_GAS = 17_284n;

/**
 * A step that executed past its declared deadline and reverted harmlessly.
 *
 * Worth noting because it is the path a cautious player takes most often, and at 1,710 gas of
 * execution it is almost free next to the 21,000 intrinsic cost. Declining a risky move costs the
 * player almost nothing beyond the base fee — which is what makes the SAFE/DASH choice a real one
 * rather than a formality.
 */
export const MEASURED_STEP_MISSED_WINDOW_GAS = 1_710n;

/**
 * The winning step. Materially more expensive than any other because it also writes `roundWinner`
 * from zero, a fresh non-zero SSTORE.
 *
 * Sizing every step off the ordinary figure would make exactly one transaction per round run out
 * of gas: the one that wins it. That is why the client raises its limit for the final steps.
 */
export const MEASURED_STEP_WINNING_GAS = 39_268n;

/**
 * A brand-new address joining as the first player of a round. The worst case for `join`.
 *
 * Measured with a never-before-seen address on purpose. An address that played a previous round
 * overwrites a non-zero player slot for 5,000 gas instead of writing a fresh one for 20,000, and
 * the first join of a round also takes the roster length slot from zero. Measuring with a reused
 * address gave 41,420 — declaring that would have failed every genuinely new player at the moment
 * they tried to get in.
 */
export const MEASURED_JOIN_FIRST_OF_ROUND_GAS = 75_620n;

/** Starting a round. Called once per round by whoever gets there first. */
export const MEASURED_START_ROUND_GAS = 49_789n;

/* ------------------------------------------------------------------ *
 * Declared limits
 * ------------------------------------------------------------------ */

/** Limit for an ordinary step. This is what the overwhelming majority of taps declare. */
export const STEP_GAS_LIMIT = withMargin(LIVE_STEP_GAS);

/** Limit for a step that might be the winning one. */
export const WINNING_STEP_GAS_LIMIT = withMargin(LIVE_STEP_GAS + WINNING_STEP_EXTRA_GAS);

export const JOIN_GAS_LIMIT = withMargin(LIVE_JOIN_GAS);

export const START_ROUND_GAS_LIMIT = withMargin(LIVE_START_ROUND_GAS);

/**
 * How many steps from the finish the client starts declaring the winning-step limit.
 *
 * 2, not 1. The client derives its position from events and contract reads, and if that view were
 * one step stale it would declare the ordinary limit for the winning transaction and lose the
 * race to an out-of-gas error. One step of slack costs about 23,000 gas of over-declaration on at
 * most two transactions per player per round — a rounding error against the certainty of the
 * winning move actually landing.
 */
export const WINNING_LIMIT_LOOKAHEAD_STEPS = 2;

/**
 * The gas limit to declare for a step, given how far along the player is.
 *
 * @param pos Steps already completed.
 * @param trackLength Steps needed to win.
 */
export function stepGasLimit(pos: number, trackLength: number): bigint {
  return pos >= trackLength - WINNING_LIMIT_LOOKAHEAD_STEPS ? WINNING_STEP_GAS_LIMIT : STEP_GAS_LIMIT;
}

/**
 * What a wallet's habitual 1.5x-on-estimate default would declare for an ordinary step, for
 * comparison only.
 *
 * Kept here so the UI can show the difference honestly rather than asserting a saving with nothing
 * behind it. The baseline is 1.5x applied to the same measured cost, which is the closest
 * like-for-like comparison available without running a second wallet.
 */
export const NAIVE_STEP_GAS_LIMIT = (LIVE_STEP_GAS * 15_000n) / BPS_DENOMINATOR;
