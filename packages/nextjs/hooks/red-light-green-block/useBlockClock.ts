"use client";

import { useEffect, useRef, useState } from "react";
import { MEASURED_BLOCK_TIME_MS, WEBSOCKET_URL } from "~~/utils/red-light-green-block/rpc";

/**
 * The current block number, driven by Monad's WebSocket head feed.
 *
 * WHY A SUBSCRIPTION AND NOT POLLING. Blocks arrive every ~305ms. A room of phones each polling
 * `eth_blockNumber` at that rate would spend the entire shared rate-limit budget on finding out
 * what the block number is, leaving nothing for actually sending steps. One subscription per
 * client costs one connection and then nothing.
 *
 * COMMITMENT LEVELS. `monadNewHeads` is Monad-specific: each block is announced four times, as
 * `Proposed` -> `Voted` -> `Verified` -> `Finalized`. Measured on the live testnet: 104 messages
 * for 26 blocks over 8 seconds, exactly four per block. `Proposed` is speculative — it is the
 * chain telling you what it currently believes, before that belief is settled.
 *
 * The game clock deliberately follows `Proposed`, because that is the earliest honest signal and
 * the whole game is about acting inside a 300ms window. The commitment level of each block is kept
 * alongside it so the UI can show how settled a block is rather than pretending speculative and
 * finalized are the same thing.
 *
 * `wss://testnet-rpc.monad.xyz` is the only endpoint that accepts these subscriptions — drpc
 * rejects them on the free plan and monadinfra refuses the connection outright — so there is no
 * failover here, only a fallback to HTTP polling.
 */

export type CommitState = "Proposed" | "Voted" | "Verified" | "Finalized";

export const COMMIT_ORDER: CommitState[] = ["Proposed", "Voted", "Verified", "Finalized"];

export function commitRank(state: CommitState | undefined): number {
  return state ? COMMIT_ORDER.indexOf(state) : -1;
}

export type BlockClock = {
  /** Highest block seen, at any commitment level. This is the game clock. */
  blockNumber: bigint | undefined;
  /** Commitment level per recent block number, newest-biased. */
  commitByBlock: Map<string, CommitState>;
  /** Highest block that has reached `Finalized`. */
  finalizedBlock: bigint | undefined;
  connected: boolean;
  /** How the block number is currently arriving. Surfaced so the UI never implies more than it knows. */
  source: "websocket" | "http" | "none";
};

/** Blocks of commitment history to keep. ~40 blocks is 12s, plenty for the UI and bounded. */
const HISTORY = 80;

export function useBlockClock(httpFallbackPoll?: () => Promise<bigint>): BlockClock {
  const [blockNumber, setBlockNumber] = useState<bigint>();
  const [finalizedBlock, setFinalizedBlock] = useState<bigint>();
  const [connected, setConnected] = useState(false);
  const [source, setSource] = useState<"websocket" | "http" | "none">("none");
  const commitRef = useRef(new Map<string, CommitState>());
  const [, forceRender] = useState(0);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let httpTimer: ReturnType<typeof setInterval>;
    let attempt = 0;

    const startHttpFallback = () => {
      if (!httpFallbackPoll || httpTimer) return;
      setSource(prev => (prev === "websocket" ? prev : "http"));
      httpTimer = setInterval(async () => {
        try {
          const next = await httpFallbackPoll();
          setBlockNumber(prev => (prev === undefined || next > prev ? next : prev));
        } catch {
          // Already retried inside the pool; nothing useful to add here.
        }
      }, 1000);
    };

    const stopHttpFallback = () => {
      if (httpTimer) {
        clearInterval(httpTimer);
        httpTimer = undefined as unknown as ReturnType<typeof setInterval>;
      }
    };

    const connect = () => {
      if (closed) return;

      try {
        socket = new WebSocket(WEBSOCKET_URL);
      } catch {
        startHttpFallback();
        return;
      }

      socket.onopen = () => {
        attempt = 0;
        setConnected(true);
        setSource("websocket");
        stopHttpFallback();
        socket?.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["monadNewHeads"] }));
      };

      socket.onmessage = event => {
        let message: {
          method?: string;
          params?: { result?: { number?: string; commitState?: CommitState } };
        };
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }

        const result = message?.params?.result;
        if (message.method !== "eth_subscription" || !result?.number) return;

        const number = BigInt(result.number);
        const commitState = result.commitState;

        if (commitState) {
          const key = number.toString();
          const existing = commitRef.current.get(key);
          // Never move a block backwards: messages are not guaranteed to arrive in order.
          if (commitRank(commitState) > commitRank(existing)) {
            commitRef.current.set(key, commitState);
          }
          if (commitState === "Finalized") {
            setFinalizedBlock(prev => (prev === undefined || number > prev ? number : prev));
          }
          // Bound the map so a long-running stage view cannot grow it without limit.
          if (commitRef.current.size > HISTORY * 2) {
            const cutoff = number - BigInt(HISTORY);
            for (const key of commitRef.current.keys()) {
              if (BigInt(key) < cutoff) commitRef.current.delete(key);
            }
          }
        }

        setBlockNumber(prev => (prev === undefined || number > prev ? number : prev));
        forceRender(n => n + 1);
      };

      const scheduleReconnect = () => {
        setConnected(false);
        if (closed) return;
        startHttpFallback();
        attempt++;
        // Backoff with jitter, capped: a venue-wifi blip should not turn into a reconnect storm
        // from every phone in the room at once.
        const wait = Math.min(500 * 2 ** Math.min(attempt, 5), 8000);
        reconnectTimer = setTimeout(connect, wait / 2 + Math.random() * (wait / 2));
      };

      socket.onerror = () => socket?.close();
      socket.onclose = scheduleReconnect;
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      stopHttpFallback();
      socket?.close();
    };
  }, [httpFallbackPoll]);

  return {
    blockNumber,
    commitByBlock: commitRef.current,
    finalizedBlock,
    connected,
    source,
  };
}

/** Seconds a span of blocks represents, using the measured 304.8ms cadence. */
export function blocksToSeconds(blocks: bigint | number): number {
  return (Number(blocks) * MEASURED_BLOCK_TIME_MS) / 1000;
}
