"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeEventLog } from "viem";
import { RED_LIGHT_GREEN_BLOCK_ABI } from "~~/utils/red-light-green-block/abi";
import { type CommitState, advanceCommit } from "~~/utils/red-light-green-block/commit";
import { WEBSOCKET_URL } from "~~/utils/red-light-green-block/rpc";

/**
 * Live game state for the stage view, driven by one `monadLogs` subscription.
 *
 * WHY ONE SUBSCRIPTION AND NOT POLLING. A stage view that polled `getPlayers()` every block would
 * spend the shared per-IP rate limit that the players in the room need for their steps. One
 * WebSocket subscription costs one connection and then nothing, no matter how many players are
 * moving.
 *
 * THE SIGNATURE BIT: COMMITMENT LEVELS AS THE VISUAL LANGUAGE.
 * `monadLogs` is Monad-specific. It delivers logs speculatively, tagged with a `commitState` that
 * advances `Proposed` -> `Voted` -> `Verified` -> `Finalized`. A move therefore appears on screen
 * the instant the chain *believes* it happened, and then visibly hardens as that belief settles.
 *
 * This is not a cosmetic flourish, and it is deliberately not presented as one. A `Proposed` move
 * is genuinely less certain than a `Finalized` one, and on most chains a UI hides that behind a
 * spinner and a guess. Here the uncertainty is the thing being drawn: a ghost dot is the honest
 * rendering of "the chain currently thinks this happened".
 *
 * Two properties matter for correctness:
 *   - A move's commitment level never moves backwards. Messages are not guaranteed to arrive in
 *     order, so a late `Proposed` after a `Verified` must be ignored, not applied.
 *   - Speculative state can be WRONG. A block that is proposed need not be the block that gets
 *     finalized. Positions are therefore keyed by the highest commitment seen, and the UI says
 *     which level it is showing rather than implying everything on screen is settled.
 */

export type PlayerRow = {
  address: string;
  pos: number;
  eliminated: boolean;
  won: boolean;
  /** Highest commitment level seen for this player's most recent move. */
  commit: CommitState;
  /** Wall-clock ms of the last update, used to animate recent movement. */
  updatedAt: number;
};

export type GameFeed = {
  players: Map<string, PlayerRow>;
  /** Transactions observed in each recent block, newest last. */
  txPerBlock: { blockNumber: bigint; count: number }[];
  connected: boolean;
  eventsSeen: number;
};

const MAX_BLOCK_HISTORY = 40;

export function useGameFeed(contractAddress: `0x${string}` | undefined, currentRoundId: number | undefined) {
  const playersRef = useRef(new Map<string, PlayerRow>());
  const blockCountsRef = useRef(new Map<string, number>());
  const [connected, setConnected] = useState(false);
  const [eventsSeen, setEventsSeen] = useState(0);
  const [, forceRender] = useState(0);

  /** Clear everything when the round changes: last round's positions are not this round's. */
  const reset = useCallback(() => {
    playersRef.current.clear();
    blockCountsRef.current.clear();
    forceRender(n => n + 1);
  }, []);

  useEffect(() => {
    reset();
  }, [currentRoundId, reset]);

  useEffect(() => {
    if (!contractAddress) return;

    let socket: WebSocket | undefined;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      try {
        socket = new WebSocket(WEBSOCKET_URL);
      } catch {
        return;
      }

      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        socket?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_subscribe",
            params: ["monadLogs", { address: contractAddress }],
          }),
        );
      };

      socket.onmessage = event => {
        let message: {
          method?: string;
          params?: {
            result?: {
              topics?: `0x${string}`[];
              data?: `0x${string}`;
              blockNumber?: string;
              commitState?: CommitState;
            };
          };
        };
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }

        const log = message?.params?.result;
        if (message.method !== "eth_subscription" || !log?.topics?.length) return;

        const commit: CommitState = log.commitState ?? "Proposed";

        let decoded: { eventName: string; args: Record<string, unknown> };
        try {
          decoded = decodeEventLog({
            abi: RED_LIGHT_GREEN_BLOCK_ABI,
            topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            data: log.data,
          }) as { eventName: string; args: Record<string, unknown> };
        } catch {
          return;
        }

        // Count transactions per block only once, at Proposed, or every log would be counted four
        // times as it advances through the commitment levels.
        if (log.blockNumber && commit === "Proposed") {
          const key = BigInt(log.blockNumber).toString();
          blockCountsRef.current.set(key, (blockCountsRef.current.get(key) ?? 0) + 1);
          if (blockCountsRef.current.size > MAX_BLOCK_HISTORY * 2) {
            const cutoff = BigInt(log.blockNumber) - BigInt(MAX_BLOCK_HISTORY);
            for (const k of blockCountsRef.current.keys()) {
              if (BigInt(k) < cutoff) blockCountsRef.current.delete(k);
            }
          }
        }

        const player = (decoded.args.player as string | undefined)?.toLowerCase();
        const eventRoundId = Number(decoded.args.roundId ?? -1);

        // Ignore anything from a previous round; stale positions would be worse than none.
        if (currentRoundId !== undefined && eventRoundId !== currentRoundId) return;
        if (!player) return;

        const existing = playersRef.current.get(player);
        const next: PlayerRow = existing ?? {
          address: player,
          pos: 0,
          eliminated: false,
          won: false,
          commit,
          updatedAt: Date.now(),
        };

        switch (decoded.eventName) {
          case "Joined":
            break;
          case "Stepped": {
            const newPos = Number(decoded.args.newPos ?? 0);
            // Never let a late speculative message drag a position backwards.
            if (newPos >= next.pos) {
              next.pos = newPos;
              next.updatedAt = Date.now();
            }
            break;
          }
          case "Eliminated":
            next.eliminated = true;
            next.updatedAt = Date.now();
            break;
          case "Won":
            next.won = true;
            next.updatedAt = Date.now();
            break;
          default:
            return;
        }

        // Commitment only ever advances. Observed live on testnet, one log from this contract was
        // delivered Proposed -> Voted -> Finalized -> Verified, so taking the latest arrival would
        // make a solid dot visibly fade back.
        next.commit = advanceCommit(existing?.commit, commit);

        playersRef.current.set(player, next);
        setEventsSeen(n => n + 1);
        forceRender(n => n + 1);
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt++;
        const wait = Math.min(500 * 2 ** Math.min(attempt, 5), 8000);
        reconnectTimer = setTimeout(connect, wait / 2 + Math.random() * (wait / 2));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [contractAddress, currentRoundId]);

  const txPerBlock = [...blockCountsRef.current.entries()]
    .map(([blockNumber, count]) => ({ blockNumber: BigInt(blockNumber), count }))
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1))
    .slice(-MAX_BLOCK_HISTORY);

  return { players: playersRef.current, txPerBlock, connected, eventsSeen };
}
