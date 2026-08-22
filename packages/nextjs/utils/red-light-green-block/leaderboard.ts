/**
 * All-day win tally, derived entirely from `Won` events.
 *
 * WHY THIS IS NOT ON-CHAIN. A `wins` mapping would mean the winning transaction of every round
 * writes a shared slot, and a "total rounds played" counter would be worse still. The whole point
 * of the storage design is that no transaction writes anything another player's transaction reads.
 * A leaderboard is a presentation concern and belongs off-chain, where it costs nobody a slot.
 *
 * WHY IT IS PERSISTED LOCALLY. `eth_getLogs` is capped at a 100-block range on Monad testnet,
 * which at 304.8ms per block is thirty seconds of history. Rebuilding a day's results from log
 * history would need hundreds of paged requests against the same rate limit the players are using,
 * and would still be fragile. So the stage view accumulates results live from the `monadLogs`
 * subscription and keeps them in `localStorage`, which survives a refresh, a crashed tab, or the
 * laptop being reopened.
 *
 * The honest limitation, stated rather than hidden: this is the tally as seen BY THIS SCREEN. A
 * stage view that was closed during a round did not see it and will under-count. It is a scoreboard
 * for a room, not a canonical record — the canonical record is the `Won` events on chain.
 */

const STORAGE_KEY = "rlgb.leaderboard.v1";

export type LeaderboardEntry = {
  address: string;
  wins: number;
  /** Round ids this address won, newest last. Used to ignore duplicate deliveries. */
  rounds: number[];
  lastWonAt: number;
};

export type Leaderboard = {
  entries: LeaderboardEntry[];
  roundsSeen: number[];
};

export function emptyLeaderboard(): Leaderboard {
  return { entries: [], roundsSeen: [] };
}

/**
 * Records a win.
 *
 * Idempotent per round. `monadLogs` delivers every log four times, once per commitment level, so a
 * naive counter would show every winner with four wins. Round ids are tracked so a repeat delivery
 * is ignored no matter which commitment level it arrives at, or in what order.
 */
export function recordWin(board: Leaderboard, address: string, roundId: number, at = Date.now()): Leaderboard {
  const player = address.toLowerCase();
  const existing = board.entries.find(entry => entry.address === player);

  if (existing?.rounds.includes(roundId)) return board;
  // Guard against two different addresses being credited with the same round, which would mean we
  // had mis-parsed something rather than that the round genuinely had two winners.
  if (board.roundsSeen.includes(roundId) && !existing) return board;

  const entries = existing
    ? board.entries.map(entry =>
        entry.address === player
          ? { ...entry, wins: entry.wins + 1, rounds: [...entry.rounds, roundId], lastWonAt: at }
          : entry,
      )
    : [...board.entries, { address: player, wins: 1, rounds: [roundId], lastWonAt: at }];

  return {
    entries: entries.sort((a, b) => b.wins - a.wins || b.lastWonAt - a.lastWonAt),
    roundsSeen: board.roundsSeen.includes(roundId) ? board.roundsSeen : [...board.roundsSeen, roundId],
  };
}

export function topEntries(board: Leaderboard, limit = 10): LeaderboardEntry[] {
  return board.entries.slice(0, limit);
}

export function totalRounds(board: Leaderboard): number {
  return board.roundsSeen.length;
}

export function loadLeaderboard(): Leaderboard {
  if (typeof window === "undefined") return emptyLeaderboard();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLeaderboard();
    const parsed = JSON.parse(raw) as Leaderboard;
    // Validate rather than trust: a half-written or older-shaped value must not crash the screen
    // that the whole room is looking at.
    if (!Array.isArray(parsed?.entries) || !Array.isArray(parsed?.roundsSeen)) return emptyLeaderboard();
    return parsed;
  } catch {
    return emptyLeaderboard();
  }
}

export function saveLeaderboard(board: Leaderboard): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
  } catch {
    // A full or disabled localStorage must never take the stage view down.
  }
}
