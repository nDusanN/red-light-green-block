"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { useBlockClock } from "~~/hooks/red-light-green-block/useBlockClock";
import { useGameFeed } from "~~/hooks/red-light-green-block/useGameFeed";
import { RED_LIGHT_GREEN_BLOCK_ABI } from "~~/utils/red-light-green-block/abi";
import { type ChainBaseline, loadMultiple, sampleBaseline } from "~~/utils/red-light-green-block/chainload";
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
import * as sound from "~~/utils/red-light-green-block/sound";
import { LIGHT, MONAD, PLAYER } from "~~/utils/red-light-green-block/theme";

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

  // Measured once at startup rather than hardcoded: a number baked into source is a number that
  // silently becomes a lie.
  // Whoever is looking at this screen may also be playing on their phone. Reading their burner
  // address lets their own dot be highlighted, which with fifty dots on a projector is the
  // difference between watching the screen and looking back down at the phone.
  const [me, setMe] = useState<string>();
  useEffect(() => {
    try {
      const key = window.localStorage.getItem("rlgb.burner.privateKey.v1");
      if (key)
        import("viem/accounts").then(m => setMe(m.privateKeyToAccount(key as `0x${string}`).address.toLowerCase()));
    } catch {
      // No burner on this device; nothing to highlight.
    }
  }, []);

  const [soundOn, setSoundOn] = useState(false);
  /** Addresses eliminated very recently, so their row can be made to look violent for a moment. */
  const [justDied, setJustDied] = useState<{ address: string; at: number }[]>([]);
  const knownDead = useRef(new Set<string>());
  const lastLight = useRef<boolean | undefined>(undefined);
  const lastWinner = useRef<string | undefined>(undefined);

  const [baseline, setBaseline] = useState<ChainBaseline>();
  useEffect(() => {
    sampleBaseline(pool, 20).then(setBaseline);
  }, [pool]);

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

  // Joined count, taken as the larger of the live feed and the contract's own tally.
  //
  // The feed ticks the instant a Joined log is proposed, which is what makes the number climb
  // visibly while a room is scanning. The contract count is polled every few seconds and lags, but
  // it is authoritative and covers the case where the WebSocket dropped. Taking the max means the
  // counter is never LOWER than the truth, which is the direction that matters when a presenter is
  // narrating it to a room.
  const joinedCount = Math.max(players.length, round?.playerCount ?? 0);
  const recentlyDied = justDied.filter(d => Date.now() - d.at < 4000);
  const scanning = round?.active === true && joinedCount < 5;
  const txThisBlock = feed.txPerBlock.find(b => b.blockNumber === blockNumber)?.count ?? 0;
  const peakTx = feed.txPerBlock.reduce((max, b) => Math.max(max, b.count), 0);
  const multiple = loadMultiple(peakTx, baseline);

  // The light changing is routine; a player dying to it is the moment. Both make a noise, but the
  // elimination sound is deliberately the most distinctive one in the set.
  useEffect(() => {
    if (isGreen === undefined) return;
    if (lastLight.current === undefined) {
      lastLight.current = isGreen;
      return;
    }
    if (lastLight.current !== isGreen) {
      lastLight.current = isGreen;
      if (isGreen) sound.playGreen();
      else sound.playRed();
    }
  }, [isGreen]);

  useEffect(() => {
    const newlyDead = players.filter(p => p.eliminated && !knownDead.current.has(p.address));
    if (newlyDead.length === 0) return;

    newlyDead.forEach(p => knownDead.current.add(p.address));
    const now = Date.now();
    setJustDied(previous => [...previous.slice(-30), ...newlyDead.map(p => ({ address: p.address, at: now }))]);

    // A whole red phase taking fifteen people at once should sound like an event, not fifteen
    // identical blips.
    if (newlyDead.length > 1) sound.playMassElimination(newlyDead.length);
    else sound.playElimination();
  }, [players]);

  useEffect(() => {
    const winner = round?.winner;
    if (!winner || winner === "0x0000000000000000000000000000000000000000") return;
    if (lastWinner.current === winner) return;
    lastWinner.current = winner;
    sound.playWin();
  }, [round?.winner]);

  // The callout expires by wall clock, so it needs something to re-render it away. The feed
  // usually provides that, but a quiet moment right after a cull would otherwise leave ELIMINATED
  // frozen on the projector until the next event arrived.
  useEffect(() => {
    if (justDied.length === 0) return;
    const timer = setInterval(() => {
      setJustDied(previous => {
        const kept = previous.filter(d => Date.now() - d.at < 4000);
        return kept.length === previous.length ? previous : kept;
      });
    }, 500);
    return () => clearInterval(timer);
  }, [justDied.length]);

  // A new round means a clean slate; without this, players eliminated last round would never be
  // announced again if they die in this one.
  useEffect(() => {
    knownDead.current.clear();
    setJustDied([]);
    lastWinner.current = undefined;
    if (round?.roundId) sound.playRoundStart();
  }, [round?.roundId]);

  if (!address) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-black text-white">
        <p className="text-3xl opacity-70">No contract deployed yet.</p>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen p-8 text-white transition-colors duration-150"
      style={{
        backgroundColor: MONAD.black,
        // A subtle wash of the light's colour over the Monad background, so the room can read the
        // light from the back without it fighting the brand palette.
        backgroundImage:
          isGreen === undefined
            ? "none"
            : `linear-gradient(180deg, ${isGreen ? "rgba(34,197,94,0.16)" : "rgba(239,68,68,0.18)"}, transparent 55%)`,
      }}
    >
      {/* Top bar: the light, the block ticker, the live counters */}
      <div className="flex items-start justify-between">
        <div>
          <div
            className="text-8xl font-black leading-none tracking-tighter"
            style={{ color: isGreen === undefined ? LIGHT.unknown : isGreen ? LIGHT.green : LIGHT.red }}
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
          <div className="font-mono text-5xl tabular-nums" style={{ color: MONAD.lightPurple }}>
            {blockNumber?.toString() ?? "…"}
          </div>
          <div className="text-lg opacity-60">block · 305ms</div>
          <div className="mt-2 text-lg">
            <span className="opacity-60">moves this block </span>
            <span className="font-mono text-2xl tabular-nums" style={{ color: MONAD.cyan }}>
              {txThisBlock}
            </span>
            <span className="ml-2 opacity-50">peak {peakTx}</span>
          </div>
          {baseline && (
            <div className="mt-1 text-sm leading-tight opacity-60">
              <div>
                rest of testnet ≈ {baseline.meanTxPerBlock.toFixed(1)} tx/block
                <span className="opacity-70"> (measured, {baseline.sampleSize} blocks)</span>
              </div>
              {multiple !== undefined && (
                <div className="text-amber-300">this room = {multiple.toFixed(1)}× the rest of the testnet</div>
              )}
              <div>blocks are {baseline.meanFillPercent.toFixed(1)}% full — the chain is not the constraint</div>
            </div>
          )}
        </div>
      </div>

      {/* Counters: what the room cares about.
          PLAYERS IN is deliberately the largest number after the light itself. The riskiest
          fifteen seconds of the pitch is the silence while people scan the QR, and a number
          visibly climbing turns that dead air into momentum the presenter can narrate. */}
      <div className="mt-6 flex items-end gap-10 text-center">
        <div>
          <div className="text-lg opacity-60">PLAYERS IN</div>
          <div
            className="font-mono text-8xl font-black leading-none tabular-nums transition-all"
            style={{ color: joinedCount > 0 ? LIGHT.green : MONAD.lightPurple }}
          >
            {joinedCount}
          </div>
          {scanning && (
            <div className="mt-1 animate-pulse text-sm" style={{ color: MONAD.cyan }}>
              scan the QR to join
            </div>
          )}
        </div>
        <Counter label="ALIVE" value={alive.length} color={LIGHT.green} />
        <Counter label="ELIMINATED" value={dead.length} color={LIGHT.red} />
        <Counter label="ROUND" value={round?.roundId ?? 0} color={MONAD.lightPurple} />
        <div>
          <div className="text-lg opacity-60">FEED</div>
          <div className="text-2xl font-bold" style={{ color: feed.connected ? LIGHT.green : "#FBBF24" }}>
            {feed.connected ? "live" : "reconnecting"}
          </div>
          <div className="text-xs opacity-50">{feed.eventsSeen} events</div>
          {/* Browsers refuse to start audio without a real click, so this doubles as the unlock. */}
          <button
            className="mt-1 rounded px-2 py-1 text-xs underline"
            style={{ color: soundOn ? MONAD.cyan : MONAD.lightPurple }}
            onClick={() => {
              const next = !soundOn;
              if (next) sound.unlock();
              sound.setMuted(!next);
              setSoundOn(next);
              if (next) sound.playRoundStart();
            }}
          >
            {soundOn ? "sound on" : "enable sound"}
          </button>
        </div>
      </div>

      {/* Transactions per block, so the audience sees the chain absorbing the room */}
      <div className="mt-6 flex h-16 items-end gap-[3px]">
        {feed.txPerBlock.map(b => (
          <div
            key={b.blockNumber.toString()}
            className="flex-1 rounded-t"
            data-tx={b.count}
            style={{
              height: `${Math.min(100, (b.count / Math.max(1, peakTx)) * 100)}%`,
              backgroundColor: MONAD.purple,
            }}
            title={`block ${b.blockNumber}: ${b.count} tx`}
          />
        ))}
      </div>

      {/* THE ELIMINATION CALLOUT.
          Judges consistently say one clear "oh — this is possible now" moment beats a tour of
          features, and ours is the first time somebody in the room dies live in front of their
          peers. So this is deliberately the loudest element on the screen while it is up: bigger
          than the light, impossible to miss, and it names who died. A red phase that takes fifteen
          people should look like an event, not a quiet state change. */}
      {recentlyDied.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 top-1/3 z-50 flex flex-col items-center">
          <div
            className="animate-pulse text-center text-8xl font-black tracking-tighter"
            style={{ color: LIGHT.red, textShadow: `0 0 40px ${LIGHT.red}` }}
          >
            {recentlyDied.length > 1 ? `${recentlyDied.length} ELIMINATED` : "ELIMINATED"}
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            {recentlyDied.slice(-8).map(d => (
              <span
                key={d.address + d.at}
                className="rounded-lg px-3 py-1 font-mono text-2xl font-bold"
                style={{ backgroundColor: LIGHT.red, color: "#fff" }}
              >
                {d.address.slice(0, 6)}…{d.address.slice(-4)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* The track */}
      <div className="mt-8 space-y-2">
        {players.length === 0 && <p className="py-16 text-center text-3xl opacity-40">waiting for players…</p>}
        {players.slice(0, 24).map(player => {
          const isMe = me !== undefined && player.address === me;
          const dyingNow = recentlyDied.some(d => d.address === player.address);
          return (
            <div
              key={player.address}
              className={`flex items-center gap-3 transition-all ${dyingNow ? "animate-pulse" : ""}`}
              style={dyingNow ? { backgroundColor: "rgba(239,68,68,0.18)", borderRadius: 8 } : undefined}
            >
              <span
                className="w-28 shrink-0 font-mono text-sm"
                style={{ color: isMe ? MONAD.cyan : MONAD.lightPurple, opacity: isMe ? 1 : 0.55 }}
              >
                {isMe ? "YOU" : `${player.address.slice(0, 6)}…${player.address.slice(-4)}`}
              </span>

              <div className="relative h-7 flex-1 rounded-full" style={{ backgroundColor: MONAD.deepPurple }}>
                {/* Finish line */}
                <div className="absolute right-0 top-0 h-full w-1 rounded-full bg-white/40" />
                <div
                  className="absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full transition-all duration-150"
                  style={{
                    left: `calc(${(player.pos / TRACK_LENGTH) * 100}% - 12px)`,
                    backgroundColor: player.won
                      ? PLAYER.won
                      : player.eliminated
                        ? PLAYER.out
                        : isMe
                          ? PLAYER.you
                          : PLAYER.alive,
                    // The signature detail: speculative moves are translucent and harden as the
                    // chain's commitment advances.
                    opacity: player.eliminated ? 0.85 : COMMIT_OPACITY[player.commit],
                    boxShadow: player.won ? `0 0 20px ${PLAYER.won}` : isMe ? `0 0 14px ${PLAYER.you}` : undefined,
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
          );
        })}
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

function Counter({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div className="text-lg opacity-60">{label}</div>
      <div className="font-mono text-6xl font-black tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}
