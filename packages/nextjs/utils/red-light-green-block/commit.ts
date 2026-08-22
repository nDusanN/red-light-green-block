/**
 * Monad commitment levels, and the rule for advancing between them.
 *
 * Every block and every log is announced FOUR times as consensus settles:
 * `Proposed` -> `Voted` -> `Verified` -> `Finalized`. This is what makes the stage view's
 * ghost-to-solid rendering possible: a move can be drawn the instant the chain believes it
 * happened, then hardened as that belief firms up.
 *
 * THEY DO NOT ARRIVE IN ORDER. Observed live on Monad testnet, one `RoundStarted` log from our own
 * contract in block 55,949,133 was delivered as:
 *
 *     Proposed -> Voted -> Finalized -> Verified
 *
 * `Finalized` arrived BEFORE `Verified`. A renderer that simply used the most recent level would
 * take the dot to solid and then visibly fade it back, which on a projector reads as a glitch and
 * undermines the exact claim the visual is making.
 *
 * So commitment is treated as a RANK that only ever moves forward. This module exists separately
 * from the React hooks so that rule can be tested directly, rather than asserted in a comment.
 */

export type CommitState = "Proposed" | "Voted" | "Verified" | "Finalized";

/** Ordered weakest to strongest. Index is the rank. */
export const COMMIT_ORDER: readonly CommitState[] = ["Proposed", "Voted", "Verified", "Finalized"] as const;

/** Rank of a commitment level; -1 for unknown or absent, so anything real outranks nothing. */
export function commitRank(state: CommitState | undefined): number {
  return state ? COMMIT_ORDER.indexOf(state) : -1;
}

/**
 * The strongest of what we already had and what just arrived.
 *
 * This is the entire out-of-order defence, in one place: never downgrade.
 */
export function advanceCommit(current: CommitState | undefined, incoming: CommitState | undefined): CommitState {
  if (!current) return incoming ?? "Proposed";
  if (!incoming) return current;
  return commitRank(incoming) > commitRank(current) ? incoming : current;
}

/** True once a level is settled enough that it will not be reorganised away. */
export function isSettled(state: CommitState | undefined): boolean {
  return commitRank(state) >= commitRank("Finalized");
}

/**
 * Opacity for a dot at a given commitment level.
 *
 * Speculative is see-through, settled is solid. The uncertainty is the thing being drawn: a
 * `Proposed` move really is less certain than a `Finalized` one, and showing that is more honest
 * than the spinner most interfaces use to hide it.
 */
export const COMMIT_OPACITY: Record<CommitState, number> = {
  Proposed: 0.3,
  Voted: 0.55,
  Verified: 0.8,
  Finalized: 1,
};

export const COMMIT_LABEL: Record<CommitState, string> = {
  Proposed: "proposed",
  Voted: "voted",
  Verified: "verified",
  Finalized: "final",
};
