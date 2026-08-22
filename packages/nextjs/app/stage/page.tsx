"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { useBlockClock } from "~~/hooks/red-light-green-block/useBlockClock";
import { useGameFeed } from "~~/hooks/red-light-green-block/useGameFeed";
import { RED_LIGHT_GREEN_BLOCK_ABI } from "~~/utils/red-light-green-block/abi";
import { COMMIT_LABEL, COMMIT_OPACITY } from "~~/utils/red-light-green-block/commit";
import { type RoundInfo, gameAddress } from "~~/utils/red-light-green-block/contract";
import {
  type Leaderboard,
  emptyLeaderboard,
  loadLeaderboard,
  recordWin,
  saveLeaderboard,
  topEntries,
  totalRounds,
} from "~~/utils/red-light-green-block/leaderboard";
import { TRACK_LENGTH, blocksUntilLightChange, lightAt } from "~~/utils/red-light-green-block/light";
import { MEASURED_BLOCK_TIME_MS, RpcPool } from "~~/utils/red-light-green-block/rpc";

/**
 * The big screen. Meant to be projected while the room plays on their phones.
 *
 * It reads almost nothing. The light is computed locally from the round anchor, and every player
 * position arrives over a single `monadLogs` subscription. A stage view that polled the contract
 * every block would be spending the shared per-IP rate limit that the players in the room need for
 * their own steps — the projector would be competing with the audience.
 *
 * The point of the screen is Monad's commitment levels. A move shows up as a translucent ghost the
 * instant the chain says `Proposed`, and hardens through `Voted` and `Verified` to solid at
 * `Finalized`. That is not decoration: a proposed move genuinely is less certain than a finalized
 * one, and drawing the difference is more honest than the usual spinner that hides it.
 */

export default function StagePage() {
  const pool = useMemo(() => new RpcPool(), []);
  const httpFallback = useCallback(() => pool.blockNumber(), [pool]);
  const clock = useBlockClock(httpFallback);
  const address = gameAddress();
  const [round, setRound] = useState<RoundInfo>();

  const refreshRound = useCallback(async () => {
    if (!address) return;
    try {
      const raw = await pool.ethCall(
        address,
        encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getRoundInfo", args: [] }),
      );
      const [roundId, startBlock, endBlock, active, winner, playerCount, currentBlock] = decodeFunctionResult({
        abi: RED_LIGHT_GREEN_BLOCK_ABI,
        functionName: "getRoundInfo",
        data: raw as `0x${string}`,
      });
      setRound({
        roundId: Number(roundId),
        startBlock: BigInt(startBlock),
        endBlock: BigInt(endBlock),
        active,
        winner: winner as `0x${string}`,
        playerCount: Number(playerCount),
        currentBlock: BigInt(currentBlock),
      });
    } catch {
      // The feed carries the game; a missed round read costs nothing and retries shortly.
    }
  }, [address, pool]);

  useEffect(() => {
    refreshRound();
    const timer = setInterval(refreshRound, 5000);
    return () => clearInterval(timer);
  }, [refreshRound]);

  const feed = useGameFeed(address, round?.roundId);

  // All-day win tally, accumulated from Won events as they arrive and kept in localStorage.
  // Deliberately not on-chain: a wins mapping would mean every winning transaction writes a slot
  // other players read, which is the shared write the whole storage design avoids.
  const [board, setBoard] = useState<Leaderboard>(emptyLeaderboard());
  useEffect(() => setBoard(loadLeaderboard()), []);

  useEffect(() => {
    if (!round?.winner || round.winner === "0x0000000000000000000000000000000000000000") return;
    setBoard(previous => {
      const next = recordWin(previous, round.winner, round.roundId);
      // recordWin returns the same object for a duplicate, so this only writes on a real change.
      if (next !== previous) saveLeaderboard(next);
      return next;
    });
  }, [round?.winner, round?.roundId]);

  const blockNumber = clock.blockNumber;
  const isGreen = round && blockNumber ? lightAt(round.roundId, round.startBlock, blockNumber) : undefined;
  const blocksLeft =
    round && blockNumber ? blocksUntilLightChange(round.roundId, round.startBlock, blockNumber) : undefined;

  const players = [...feed.players.values()].sort((a, b) => b.pos - a.pos);
  const alive = players.filter(p => !p.eliminated);
  const dead = players.filter(p => p.eliminated);
  const txThisBlock = feed.txPerBlock.find(b => b.blockNumber === blockNumber)?.count ?? 0;
  const peakTx = feed.txPerBlock.reduce((max, b) => Math.max(max, b.count), 0);

  if (!address) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black text-white">
        <p className="text-3xl opacity-70">No contract deployed yet.</p>
      </main>
    );
  }

  return (
    <main
      className={`min-h-screen p-8 text-white transition-colors duration-150 ${
        isGreen === undefined ? "bg-neutral-950" : isGreen ? "bg-green-950" : "bg-red-950"
      }`}
    >
      {/* Top bar: the light, the block ticker, the live counters */}
      <div className="flex items-start justify-between">
        <div>
          <div
            className={`text-8xl font-black leading-none tracking-tighter ${
              isGreen === undefined ? "text-neutral-500" : isGreen ? "text-green-400" : "text-red-500"
            }`}
          >
            {isGreen === undefined ? "…" : isGreen ? "GREEN" : "RED"}
          </div>
          {blocksLeft !== undefined && (
            <div className="mt-1 text-2xl opacity-70">
              changes in {blocksLeft.toString()} blocks ·{" "}
              {((Number(blocksLeft) * MEASURED_BLOCK_TIME_MS) / 1000).toFixed(1)}s
            </div>
          )}
        </div>

        <div className="text-right">
          <div className="font-mono text-5xl tabular-nums">{blockNumber?.toString() ?? "…"}</div>
          <div className="text-lg opacity-60">block · 305ms</div>
          <div className="mt-2 text-lg">
            <span className="opacity-60">tx this block </span>
            <span className="font-mono text-2xl tabular-nums text-amber-300">{txThisBlock}</span>
            <span className="ml-2 opacity-50">peak {peakTx}</span>
          </div>
        </div>
      </div>

      {/* Counters: what the room cares about */}
      <div className="mt-6 flex gap-10 text-center">
        <Counter label="PLAYERS IN" value={alive.length} className="text-green-400" />
        <Counter label="ELIMINATED" value={dead.length} className="text-red-500" />
        <Counter label="ROUND" value={round?.roundId ?? 0} className="text-white/80" />
        <div>
          <div className="text-lg opacity-60">FEED</div>
          <div className={`text-2xl font-bold ${feed.connected ? "text-green-400" : "text-amber-400"}`}>
            {feed.connected ? "live" : "reconnecting"}
          </div>
          <div className="text-xs opacity-50">{feed.eventsSeen} events</div>
        </div>
      </div>

      {/* Transactions per block, so the audience sees the chain absorbing the room */}
      <div className="mt-6 flex h-16 items-end gap-[3px]">
        {feed.txPerBlock.map(b => (
          <div
            key={b.blockNumber.toString()}
            className="flex-1 rounded-t bg-amber-400/70"
            style={{ height: `${Math.min(100, (b.count / Math.max(1, peakTx)) * 100)}%` }}
            title={`block ${b.blockNumber}: ${b.count} tx`}
          />
        ))}
      </div>

      {/* The track */}
      <div className="mt-8 space-y-2">
        {players.length === 0 && <p className="py-16 text-center text-3xl opacity-40">waiting for players…</p>}
        {players.slice(0, 24).map(player => (
          <div key={player.address} className="flex items-center gap-3">
            <span className="w-28 shrink-0 font-mono text-sm opacity-50">
              {player.address.slice(0, 6)}…{player.address.slice(-4)}
            </span>

            <div className="relative h-7 flex-1 rounded-full bg-white/5">
              {/* Finish line */}
              <div className="absolute right-0 top-0 h-full w-1 rounded-full bg-white/40" />
              <div
                className="absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full transition-all duration-150"
                style={{
                  left: `calc(${(player.pos / TRACK_LENGTH) * 100}% - 12px)`,
                  backgroundColor: player.won ? "#fbbf24" : player.eliminated ? "#dc2626" : "#4ade80",
                  // The signature detail: speculative moves are translucent and harden as the
                  // chain's commitment advances.
                  opacity: player.eliminated ? 0.85 : COMMIT_OPACITY[player.commit],
                  boxShadow: player.won ? "0 0 20px #fbbf24" : undefined,
                }}
              />
            </div>

            <span className="w-14 shrink-0 text-right font-mono text-sm tabular-nums">
              {player.pos}/{TRACK_LENGTH}
            </span>
            <span className="w-20 shrink-0 text-xs opacity-40">
              {player.eliminated ? "out" : COMMIT_LABEL[player.commit]}
            </span>
          </div>
        ))}
      </div>

      {round?.winner && round.winner !== "0x0000000000000000000000000000000000000000" && (
        <div className="mt-8 text-center text-5xl font-black text-amber-400">
          🏆 {round.winner.slice(0, 8)}… WINS ROUND {round.roundId}
        </div>
      )}

      {/* All-day leaderboard: the reason to keep playing between pitches. */}
      {board.entries.length > 0 && (
        <div className="mt-8">
          <div className="mb-2 flex items-baseline justify-between text-lg opacity-60">
            <span>ALL-DAY WINS</span>
            <span className="text-sm">{totalRounds(board)} rounds seen by this screen</span>
          </div>
          <div className="flex flex-wrap gap-3">
            {topEntries(board, 8).map((entry, i) => (
              <div
                key={entry.address}
                className={`rounded-xl px-4 py-2 ${i === 0 ? "bg-amber-400/20 text-amber-300" : "bg-white/5"}`}
              >
                <span className="font-mono text-sm opacity-70">
                  {entry.address.slice(0, 6)}…{entry.address.slice(-4)}
                </span>
                <span className="ml-3 font-mono text-xl font-black tabular-nums">{entry.wins}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-8 text-center text-sm opacity-40">
        The light is a pure function of the block number. No server, no admin, no oracle. Dots fade in when Monad
        proposes a block and solidify as it finalises.
      </p>
    </main>
  );
}

function Counter({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div>
      <div className="text-lg opacity-60">{label}</div>
      <div className={`font-mono text-6xl font-black tabular-nums ${className ?? ""}`}>{value}</div>
    </div>
  );
}
