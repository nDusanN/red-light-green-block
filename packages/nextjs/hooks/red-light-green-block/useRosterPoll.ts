"use client";

import { useCallback, useEffect, useState } from "react";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { RED_LIGHT_GREEN_BLOCK_ABI } from "~~/utils/red-light-green-block/abi";
import { RpcPool } from "~~/utils/red-light-green-block/rpc";

/**
 * Fallback source of player state, polled from the contract.
 *
 * The stage view is driven by `monadLogs`, which is Monad-specific. That is the right primary
 * source and it is what makes the commitment-level rendering possible, but it leaves two real
 * holes:
 *
 *   1. On any non-Monad chain — a local Anvil, a fork — the subscription does not exist, so the
 *      screen would sit empty forever. That matters more than it sounds: the local Anvil run is
 *      the fallback demo if the testnet deploy cannot be funded.
 *   2. If the WebSocket drops mid-demo, the screen would freeze with stale positions and no
 *      indication that it had stopped being true.
 *
 * So this polls `getRoster` + `getPlayers` instead. It is deliberately the SECONDARY source: it
 * costs two `eth_call`s per poll against a rate limit the players need, so it runs slowly and only
 * when the feed is not delivering. Positions from here are authoritative rather than speculative —
 * they are reported as `Finalized`, because a contract read at `latest` is not a guess.
 *
 * This is the reason the on-chain roster is worth its one shared write: without it, enumerating
 * the field would mean a historical log query, which is the least reliable thing to lean on at a
 * live event.
 */

export type PolledPlayer = {
  address: string;
  pos: number;
  eliminated: boolean;
};

const PAGE_SIZE = 100n;

export function useRosterPoll(
  contractAddress: `0x${string}` | undefined,
  roundId: number | undefined,
  pool: RpcPool,
  enabled: boolean,
  intervalMs = 2500,
) {
  const [players, setPlayers] = useState<PolledPlayer[]>([]);
  const [error, setError] = useState<string>();

  const poll = useCallback(async () => {
    if (!contractAddress || roundId === undefined || roundId === 0) return;

    try {
      const rosterRaw = await pool.ethCall(
        contractAddress,
        encodeFunctionData({
          abi: RED_LIGHT_GREEN_BLOCK_ABI,
          functionName: "getRoster",
          args: [roundId, 0n, PAGE_SIZE],
        }),
      );
      const roster = decodeFunctionResult({
        abi: RED_LIGHT_GREEN_BLOCK_ABI,
        functionName: "getRoster",
        data: rosterRaw as `0x${string}`,
      }) as readonly `0x${string}`[];

      if (roster.length === 0) {
        setPlayers([]);
        return;
      }

      // One call for the whole field, not one per player. With a per-IP rate limit shared by the
      // entire room, the difference between 1 and 60 calls per poll is the difference between the
      // screen being free and the screen taking everyone's turns.
      const statesRaw = await pool.ethCall(
        contractAddress,
        encodeFunctionData({
          abi: RED_LIGHT_GREEN_BLOCK_ABI,
          functionName: "getPlayers",
          args: [roster],
        }),
      );
      const states = decodeFunctionResult({
        abi: RED_LIGHT_GREEN_BLOCK_ABI,
        functionName: "getPlayers",
        data: statesRaw as `0x${string}`,
      }) as readonly { addr: `0x${string}`; joined: boolean; pos: number; eliminated: boolean }[];

      setPlayers(
        states
          .filter(s => s.joined)
          .map(s => ({ address: s.addr.toLowerCase(), pos: Number(s.pos), eliminated: s.eliminated })),
      );
      setError(undefined);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [contractAddress, roundId, pool]);

  useEffect(() => {
    if (!enabled) return;
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, poll, intervalMs]);

  return { players, error };
}
