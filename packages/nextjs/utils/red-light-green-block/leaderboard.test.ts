import { emptyLeaderboard, recordWin, topEntries, totalRounds } from "./leaderboard.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("a win is recorded once", () => {
  const board = recordWin(emptyLeaderboard(), "0xAAA", 1);
  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].wins, 1);
  assert.equal(board.entries[0].address, "0xaaa", "addresses are normalised to lower case");
  assert.equal(totalRounds(board), 1);
});

test("the same round delivered four times counts once", () => {
  // monadLogs delivers every log once per commitment level. A naive counter would show every
  // winner with four wins, which is exactly the kind of wrong number that gets noticed on a
  // projector.
  let board = emptyLeaderboard();
  for (let i = 0; i < 4; i++) board = recordWin(board, "0xAAA", 7);

  assert.equal(board.entries[0].wins, 1);
  assert.equal(totalRounds(board), 1);
});

test("wins accumulate across different rounds", () => {
  let board = emptyLeaderboard();
  board = recordWin(board, "0xAAA", 1);
  board = recordWin(board, "0xAAA", 2);
  board = recordWin(board, "0xBBB", 3);

  assert.equal(board.entries[0].address, "0xaaa");
  assert.equal(board.entries[0].wins, 2);
  assert.equal(board.entries[1].wins, 1);
  assert.equal(totalRounds(board), 3);
});

test("case differences in an address are the same player", () => {
  let board = emptyLeaderboard();
  board = recordWin(board, "0xAbCdEf", 1);
  board = recordWin(board, "0xabcdef", 2);

  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].wins, 2);
});

test("a round cannot be credited to two different addresses", () => {
  // Only one address can win a round; if a second appeared we mis-parsed something, and inventing
  // a win is worse than dropping one.
  let board = recordWin(emptyLeaderboard(), "0xAAA", 5);
  board = recordWin(board, "0xBBB", 5);

  assert.equal(board.entries.length, 1);
  assert.equal(board.entries[0].address, "0xaaa");
});

test("entries are ranked by wins, most recent breaking ties", () => {
  let board = emptyLeaderboard();
  board = recordWin(board, "0xAAA", 1, 1000);
  board = recordWin(board, "0xBBB", 2, 2000);
  board = recordWin(board, "0xBBB", 3, 3000);
  board = recordWin(board, "0xCCC", 4, 4000);

  const top = topEntries(board);
  assert.equal(top[0].address, "0xbbb");
  assert.equal(top[0].wins, 2);
  // AAA and CCC both have one win; the more recent shows first.
  assert.equal(top[1].address, "0xccc");
  assert.equal(top[2].address, "0xaaa");
});

test("topEntries limits without mutating the board", () => {
  let board = emptyLeaderboard();
  for (let i = 0; i < 15; i++) board = recordWin(board, `0x${i}`, i);

  assert.equal(topEntries(board, 10).length, 10);
  assert.equal(board.entries.length, 15, "the board itself keeps everyone");
});

test("recording is pure: the previous board is never mutated", () => {
  const first = recordWin(emptyLeaderboard(), "0xAAA", 1);
  const second = recordWin(first, "0xAAA", 2);

  assert.equal(first.entries[0].wins, 1, "the earlier snapshot must be unchanged");
  assert.equal(second.entries[0].wins, 2);
});

test("a duplicate delivery returns the identical object, so React can skip a re-render", () => {
  const board = recordWin(emptyLeaderboard(), "0xAAA", 1);
  assert.strictEqual(recordWin(board, "0xAAA", 1), board);
});
