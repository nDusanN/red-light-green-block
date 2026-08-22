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
 * CAVEAT, STATED PLAINLY: these are Foundry measurements of the EVM's cost model, not observed
 * `gasUsed` from Monad testnet receipts. They should agree, and `scripts/check-gas.ts` re-checks
 * them against real receipts after a deploy. Until that has been run against a live deployment,
 * treat them as well-founded but unconfirmed on the real chain.
 */

/** Intrinsic cost every transaction pays before any code runs. */
export const INTRINSIC_TX_GAS = 21_000n;

/** Cost of one non-zero calldata byte. */
const CALLDATA_NONZERO_BYTE_GAS = 16n;

/**
 * Calldata cost for a call with a 4-byte selector and `words` 32-byte arguments, assuming every
 * byte is non-zero.
 *
 * Assuming all-non-zero overstates the real cost — a `uint32` block number leaves 28 leading zero
 * bytes, which cost 4 gas each rather than 16. The overstatement is about 340 gas on a ~60,000 gas
 * transaction, and it buys immunity from ever under-declaring because a block number happened to
 * have an unusual byte pattern. That trade is worth it; a much larger blanket buffer would not be.
 */
function calldataGas(words: bigint): bigint {
  return (4n + words * 32n) * CALLDATA_NONZERO_BYTE_GAS;
}

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

/** `step(uint32)` — one 32-byte argument. */
const STEP_CALLDATA_GAS = calldataGas(1n);

/** `join()` and `startRound()` — selector only. */
const NO_ARG_CALLDATA_GAS = calldataGas(0n);

/** Limit for an ordinary step. This is what the overwhelming majority of taps declare. */
export const STEP_GAS_LIMIT = withMargin(INTRINSIC_TX_GAS + STEP_CALLDATA_GAS + MEASURED_STEP_GREEN_GAS);

/** Limit for a step that might be the winning one. */
export const WINNING_STEP_GAS_LIMIT = withMargin(INTRINSIC_TX_GAS + STEP_CALLDATA_GAS + MEASURED_STEP_WINNING_GAS);

export const JOIN_GAS_LIMIT = withMargin(INTRINSIC_TX_GAS + NO_ARG_CALLDATA_GAS + MEASURED_JOIN_FIRST_OF_ROUND_GAS);

export const START_ROUND_GAS_LIMIT = withMargin(INTRINSIC_TX_GAS + NO_ARG_CALLDATA_GAS + MEASURED_START_ROUND_GAS);

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
export const NAIVE_STEP_GAS_LIMIT =
  ((INTRINSIC_TX_GAS + STEP_CALLDATA_GAS + MEASURED_STEP_GREEN_GAS) * 15_000n) / BPS_DENOMINATOR;
