import {
  COMMIT_LABEL,
  COMMIT_OPACITY,
  COMMIT_ORDER,
  type CommitState,
  advanceCommit,
  commitRank,
  isSettled,
} from "./commit.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * These tests protect the centrepiece visual.
 *
 * Monad delivers each log four times as consensus settles, and NOT in rank order. If a dot's
 * opacity followed whatever arrived last it would go solid and then visibly fade back, which on a
 * projector in front of a room reads as a bug and discredits the very thing the visual is claiming.
 */

test("ranks are ordered weakest to strongest", () => {
  assert.deepEqual([...COMMIT_ORDER], ["Proposed", "Voted", "Verified", "Finalized"]);
  assert.ok(commitRank("Proposed") < commitRank("Voted"));
  assert.ok(commitRank("Voted") < commitRank("Verified"));
  assert.ok(commitRank("Verified") < commitRank("Finalized"));
});

test("an unknown level ranks below every real one", () => {
  // So a first sighting always wins over "nothing seen yet".
  assert.equal(commitRank(undefined), -1);
  assert.ok(commitRank(undefined) < commitRank("Proposed"));
});

test("the exact out-of-order sequence observed on testnet never downgrades", () => {
  // Live capture, one RoundStarted log from our contract in block 55,949,133:
  // Finalized arrived BEFORE Verified.
  const observed: CommitState[] = ["Proposed", "Voted", "Finalized", "Verified"];

  let current: CommitState | undefined;
  const seen: CommitState[] = [];
  for (const incoming of observed) {
    current = advanceCommit(current, incoming);
    seen.push(current);
  }

  assert.deepEqual(seen, ["Proposed", "Voted", "Finalized", "Finalized"]);
  assert.equal(current, "Finalized", "the late Verified must not undo Finalized");
});

test("opacity never decreases across any arrival order", () => {
  // Exhaustive over every permutation of the four levels: whatever order the feed delivers them
  // in, the dot may only ever get more solid.
  const permutations: CommitState[][] = [];
  const build = (rest: CommitState[], acc: CommitState[]) => {
    if (rest.length === 0) return void permutations.push(acc);
    rest.forEach((item, i) => build([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, item]));
  };
  build([...COMMIT_ORDER], []);
  assert.equal(permutations.length, 24);

  for (const order of permutations) {
    let current: CommitState | undefined;
    let lastOpacity = 0;
    for (const incoming of order) {
      current = advanceCommit(current, incoming);
      const opacity = COMMIT_OPACITY[current];
      assert.ok(opacity >= lastOpacity, `opacity fell from ${lastOpacity} to ${opacity} in ${order.join(">")}`);
      lastOpacity = opacity;
    }
    // However they arrived, all four seen means fully settled.
    assert.equal(current, "Finalized");
  }
});

test("advanceCommit handles missing values without losing progress", () => {
  assert.equal(advanceCommit(undefined, "Voted"), "Voted");
  assert.equal(advanceCommit("Verified", undefined), "Verified", "a level-less message must not reset");
  assert.equal(advanceCommit(undefined, undefined), "Proposed", "default to the weakest claim, never the strongest");
});

test("repeated deliveries of the same level are stable", () => {
  // The feed repeats; idempotence keeps the UI from flickering.
  let current: CommitState | undefined = "Voted";
  for (let i = 0; i < 5; i++) current = advanceCommit(current, "Voted");
  assert.equal(current, "Voted");
});

test("isSettled is true only at Finalized", () => {
  assert.equal(isSettled("Proposed"), false);
  assert.equal(isSettled("Voted"), false);
  assert.equal(isSettled("Verified"), false);
  assert.equal(isSettled("Finalized"), true);
  assert.equal(isSettled(undefined), false);
});

test("every level has an opacity and a label, and speculative is visibly weaker", () => {
  for (const state of COMMIT_ORDER) {
    assert.ok(COMMIT_OPACITY[state] > 0 && COMMIT_OPACITY[state] <= 1);
    assert.ok(COMMIT_LABEL[state].length > 0);
  }
  // The whole point: a proposed move must look meaningfully less certain than a finalized one.
  assert.ok(COMMIT_OPACITY.Finalized - COMMIT_OPACITY.Proposed > 0.5);
});
