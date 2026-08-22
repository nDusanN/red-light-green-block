"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeErrorResult, formatEther } from "viem";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import { useBlockClock } from "~~/hooks/red-light-green-block/useBlockClock";
import { useBurner } from "~~/hooks/red-light-green-block/useBurner";
import { RED_LIGHT_GREEN_BLOCK_ABI, type RoundInfo, gameAddress } from "~~/utils/red-light-green-block/contract";
import { JOIN_GAS_LIMIT, START_ROUND_GAS_LIMIT, stepGasLimit } from "~~/utils/red-light-green-block/gas";
import { TRACK_LENGTH, blocksUntilLightChange, lightAt, stepWindow } from "~~/utils/red-light-green-block/light";
import { MEASURED_BLOCK_TIME_MS, RpcPool } from "~~/utils/red-light-green-block/rpc";

/**
 * The player view. One phone, one thumb.
 *
 * Two deliberate properties, both of which exist because of how the chain actually behaves:
 *
 * 1. THE LIGHT IS COMPUTED HERE, never fetched. `lightAt` is a pure function of the block number
 *    and the round anchor, and the anchor is read once when the round is picked up. So the page
 *    makes zero RPC reads to render the light, at any frame rate, forever. That is what leaves the
 *    shared per-IP rate limit free for actually sending steps.
 *
 * 2. SAFE and DASH are the whole game. Both send the same `step()`; they differ only in the
 *    deadline the player attaches. SAFE says "only the very next block", which the player can
 *    already see the colour of. DASH says "anything in the next four", which is far more likely to
 *    land but may land after the light turns. The window is drawn out block by block so the choice
 *    is informed rather than a gamble.
 */

/**
 * How far ahead each button lets the transaction execute.
 *
 * MEASURED, and the first values were wrong. With SAFE at 1 the game was unplayable on a phone:
 * every tap came back "missed the window". A client cannot observe blocks as fast as they are
 * produced -- polling `eth_blockNumber` in a tight loop for 9 seconds saw 27 transitions with gaps
 * of min 57ms / p50 309ms / max 612ms against a true 300ms block time, so the observed block
 * number is routinely one to two blocks stale before signing even begins.
 *
 * `maxBlock = observed + 1` therefore often names a block that is already in the past, and the
 * contract correctly refuses to execute. The mechanism was working exactly as designed; the
 * numbers were simply not physical.
 *
 * Tuned from measured click-to-inclusion against the deployed contract, not guessed: send-to-
 * receipt was p50 945ms and p90 1259ms, which at 304.8ms/block is 3.1 and 4.1 blocks. SAFE is set
 * above the p90 so an honest "you cannot die" actually holds; an intermediate value of 3 was tried
 * and still missed most windows.
 *
 * This does not soften the game. SAFE still means "every block I could land in is green, so I
 * cannot die" -- it just needs six green blocks ahead rather than one, and the UI draws every one
 * of them so the guarantee stays visible and checkable. Green runs are 12-30 blocks, so a SAFE
 * step is available for most of every green phase. DASH still reaches past what can be seen.
 */
const SAFE_LOOKAHEAD = 6n;
const DASH_LOOKAHEAD = 12n;

type Outcome = {
  kind: "stepped" | "eliminated" | "missed" | "error" | "pending";
  text: string;
  at: number;
};

export default function PlayPage() {
  const pool = useMemo(() => new RpcPool(), []);
  const httpFallback = useCallback(() => pool.blockNumber(), [pool]);
  const clock = useBlockClock(httpFallback);
  const burner = useBurner(pool);

  const address = gameAddress();
  const [round, setRound] = useState<RoundInfo>();
  const [me, setMe] = useState<{ joined: boolean; pos: number; eliminated: boolean }>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [busy, setBusy] = useState(false);
  const [latency, setLatency] = useState<{ p50Ms: number; blocks: number }>();
  const [netWarning, setNetWarning] = useState<string>();
  const lastActedBlock = useRef<bigint | undefined>(undefined);
  /** Freshest observed block, updated every tick so a press never uses a stale render value. */
  const clockRef = useRef<bigint | undefined>(undefined);
  const sentAtBlock = useRef<bigint | undefined>(undefined);
  /** Click-to-inclusion, in blocks. Measured so SAFE_LOOKAHEAD can be tuned from data. */
  const [inclusionBlocks, setInclusionBlocks] = useState<number[]>([]);
  const consecutiveMisses = useRef(0);

  // One eth_call to pick up the round anchor. After this the light is entirely local.
  const refreshRound = useCallback(async () => {
    if (!address) return;
    try {
      const raw = await pool.ethCall(
        address,
        encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getRoundInfo", args: [] }),
      );
      // viem decodes uint48 as `number`, not `bigint` -- everything <= 48 bits fits safely. The
      // light functions take bigint, so widen here rather than at every call site.
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
    } catch (error) {
      setNetWarning((error as Error).message);
    }
  }, [address, pool]);

  const refreshMe = useCallback(async () => {
    if (!address || !burner.address) return;
    try {
      const raw = await pool.ethCall(
        address,
        encodeFunctionData({
          abi: RED_LIGHT_GREEN_BLOCK_ABI,
          functionName: "getPlayer",
          args: [burner.address],
        }),
      );
      const [joined, pos, eliminated] = decodeFunctionResult({
        abi: RED_LIGHT_GREEN_BLOCK_ABI,
        functionName: "getPlayer",
        data: raw as `0x${string}`,
      });
      setMe({ joined, pos: Number(pos), eliminated });
    } catch {
      // Transient; the next refresh covers it.
    }
  }, [address, burner.address, pool]);

  useEffect(() => {
    refreshRound();
    const timer = setInterval(refreshRound, 6000);
    return () => clearInterval(timer);
  }, [refreshRound]);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  // Measure the player's own round-trip once, on their actual network. Shown in blocks, because
  // "45ms" means nothing to a player but "0.15 blocks" tells them how much slack they have.
  useEffect(() => {
    if (!burner.ready) return;
    pool.measureLatency(5).then(result => setLatency({ p50Ms: result.p50Ms, blocks: result.blocks }));
  }, [burner.ready, pool]);

  const blockNumber = clock.blockNumber;
  clockRef.current = blockNumber;
  const isGreen = round && blockNumber ? lightAt(round.roundId, round.startBlock, blockNumber) : undefined;
  const blocksLeft =
    round && blockNumber ? blocksUntilLightChange(round.roundId, round.startBlock, blockNumber) : undefined;

  // Client-side one-action-per-block gate. The contract enforces this too, but a player mashing
  // the button would otherwise fire ten transactions per block, nine of which revert while still
  // consuming the shared rate-limit budget everyone else needs.
  const actedThisBlock = blockNumber !== undefined && lastActedBlock.current === blockNumber;

  const send = useCallback(
    async (kind: "join" | "safe" | "dash" | "startRound") => {
      if (!address || !burner.ready || !blockNumber) return;
      setBusy(true);
      setNetWarning(undefined);
      setOutcome({ kind: "pending", text: "sending…", at: Date.now() });

      try {
        let hash: `0x${string}`;

        if (kind === "startRound") {
          hash = await burner.send({ to: address, functionName: "startRound", gas: START_ROUND_GAS_LIMIT });
        } else if (kind === "join") {
          hash = await burner.send({ to: address, functionName: "join", gas: JOIN_GAS_LIMIT });
        } else {
          const lookahead = kind === "safe" ? SAFE_LOOKAHEAD : DASH_LOOKAHEAD;
          // Read the clock again at press time. React state can be a render behind, and at 305ms
          // blocks one stale render is a whole block of the window thrown away.
          const freshest = clockRef.current ?? blockNumber;
          const maxBlock = freshest + lookahead;
          lastActedBlock.current = freshest;
          sentAtBlock.current = freshest;
          hash = await burner.send({
            to: address,
            functionName: "step",
            args: [Number(maxBlock)],
            gas: stepGasLimit(me?.pos ?? 0, TRACK_LENGTH),
          });
        }

        // Poll for the receipt rather than subscribing: one transaction, one short poll.
        for (let i = 0; i < 25; i++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          const receipt = await pool
            .call<{ status: string; blockNumber: string } | null>("eth_getTransactionReceipt", [hash])
            .catch(() => null);
          if (!receipt) continue;

          if (receipt.status === "0x1") {
            // A successful step is NOT necessarily a successful move: landing on red succeeds and
            // eliminates you. The contract cannot revert there, so the state has to be re-read.
            consecutiveMisses.current = 0;
            if (sentAtBlock.current && receipt.blockNumber) {
              const distance = Number(BigInt(receipt.blockNumber) - sentAtBlock.current);
              setInclusionBlocks(prev => [...prev.slice(-19), distance]);
            }
            await Promise.all([refreshMe(), refreshRound()]);
            setOutcome({ kind: "stepped", text: "landed", at: Date.now() });
          } else {
            consecutiveMisses.current++;
            setOutcome({
              kind: "missed",
              text:
                consecutiveMisses.current >= 2
                  ? "your connection is slow — try DASH"
                  : "missed the window — still alive",
              at: Date.now(),
            });
          }
          break;
        }
      } catch (error) {
        const message = (error as Error).message ?? "failed";
        // A missed window is the player correctly declining a risky move. It must never look like
        // a crash, because that is the play we want them to feel good about making.
        if (/StepWindowMissed/i.test(message) || /0x[0-9a-f]*/.test(message)) {
          const revert = decodeRevert(message);
          if (revert === "StepWindowMissed") {
            setOutcome({ kind: "missed", text: "too late — turn skipped, still alive", at: Date.now() });
          } else if (revert === "AlreadyActedThisBlock") {
            setOutcome({ kind: "missed", text: "one step per block — try the next one", at: Date.now() });
          } else {
            setOutcome({ kind: "error", text: revert ?? message.slice(0, 90), at: Date.now() });
          }
        } else {
          setOutcome({ kind: "error", text: message.slice(0, 90), at: Date.now() });
        }
      } finally {
        setBusy(false);
        refreshMe();
      }
    },
    [address, blockNumber, burner, me?.pos, pool, refreshMe, refreshRound],
  );

  // Refresh my state each time the block advances while I am in a round, so elimination shows up
  // immediately. This is one cheap call per block only while actually playing.
  useEffect(() => {
    if (!me?.joined || me.eliminated) return;
    refreshMe();
  }, [blockNumber, me?.joined, me?.eliminated, refreshMe]);

  const safeWindow =
    round && blockNumber
      ? stepWindow(round.roundId, round.startBlock, blockNumber, blockNumber + SAFE_LOOKAHEAD)
      : undefined;
  const dashWindow =
    round && blockNumber
      ? stepWindow(round.roundId, round.startBlock, blockNumber, blockNumber + DASH_LOOKAHEAD)
      : undefined;

  const won = round?.winner && burner.address && round.winner.toLowerCase() === burner.address.toLowerCase();

  if (!address) {
    return (
      <Shell>
        <h1 className="text-3xl font-bold">Not deployed yet</h1>
        <p className="mt-4 opacity-80">
          No contract address is configured for Monad testnet. Deploy the contract, or set
          <code className="mx-1 rounded bg-black/30 px-1">NEXT_PUBLIC_RLGB_ADDRESS</code>.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-baseline justify-between text-xs opacity-70">
        <span>block {blockNumber?.toString() ?? "…"}</span>
        <span>
          {clock.source === "websocket" ? "live feed" : clock.source === "http" ? "polling" : "connecting"}
          {latency ? ` · ping ${latency.p50Ms}ms ≈ ${latency.blocks} blk` : ""}
          {inclusionBlocks.length > 0
            ? ` · lands +${Math.round(inclusionBlocks.reduce((a, b) => a + b, 0) / inclusionBlocks.length)} blk`
            : ""}
        </span>
      </div>

      {/* The light. Deliberately the biggest thing on the screen. */}
      <div
        className={`mt-3 flex h-44 flex-col items-center justify-center rounded-3xl transition-colors duration-100 ${
          isGreen === undefined ? "bg-neutral-700" : isGreen ? "bg-green-500" : "bg-red-600"
        }`}
      >
        <div className="text-5xl font-black tracking-tight text-black/80">
          {isGreen === undefined ? "…" : isGreen ? "GREEN" : "RED"}
        </div>
        {blocksLeft !== undefined && (
          <div className="mt-1 text-sm font-semibold text-black/60">
            {blocksLeft.toString()} block{blocksLeft === 1n ? "" : "s"} left ·{" "}
            {((Number(blocksLeft) * MEASURED_BLOCK_TIME_MS) / 1000).toFixed(1)}s
          </div>
        )}
      </div>

      {/* Position */}
      <div className="mt-4">
        <div className="flex justify-between text-sm opacity-80">
          <span>
            step {me?.pos ?? 0} / {TRACK_LENGTH}
          </span>
          <span>
            {won
              ? "🏆 you won"
              : me?.eliminated
                ? "eliminated"
                : me?.joined
                  ? "alive"
                  : round?.active
                    ? "not joined"
                    : "no round"}
          </span>
        </div>
        <div className="mt-1 h-4 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full transition-all ${me?.eliminated ? "bg-red-700" : "bg-green-400"}`}
            style={{ width: `${((me?.pos ?? 0) / TRACK_LENGTH) * 100}%` }}
          />
        </div>
      </div>

      {/* Outcome */}
      <div className="mt-3 h-6 text-center text-sm">
        {outcome && (
          <span
            className={
              outcome.kind === "eliminated" || outcome.kind === "error"
                ? "text-red-400"
                : outcome.kind === "missed"
                  ? "text-amber-300"
                  : "text-green-300"
            }
          >
            {outcome.text}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="mt-2 flex-1">
        {!round?.active ? (
          <BigButton onClick={() => send("startRound")} disabled={busy} className="bg-blue-600">
            START A ROUND
            <Sub>anyone can — there is no admin</Sub>
          </BigButton>
        ) : !me?.joined ? (
          <BigButton onClick={() => send("join")} disabled={busy || !burner.balanceWei} className="bg-blue-600">
            JOIN
            <Sub>{round.playerCount} in this round</Sub>
          </BigButton>
        ) : me.eliminated ? (
          <BigButton onClick={() => send("startRound")} disabled className="bg-neutral-700">
            ELIMINATED
            <Sub>wait for the next round</Sub>
          </BigButton>
        ) : (
          <div className="flex h-full flex-col gap-3">
            <BigButton
              onClick={() => send("safe")}
              disabled={busy || actedThisBlock}
              className={safeWindow?.allGreen ? "bg-green-600" : "bg-red-700"}
            >
              SAFE STEP
              <Sub>
                {safeWindow?.allGreen ? "next block is green — guaranteed" : "next block is RED — you would die"}
              </Sub>
            </BigButton>

            <BigButton
              onClick={() => send("dash")}
              disabled={busy || actedThisBlock}
              className={dashWindow?.allGreen ? "bg-green-700" : "bg-amber-600"}
            >
              DASH
              <Sub>
                {dashWindow
                  ? dashWindow.allGreen
                    ? "next 4 blocks all green"
                    : `${dashWindow.redCount} of the next 4 blocks are RED`
                  : "…"}
              </Sub>
            </BigButton>

            {/* The window, drawn block by block, so the choice is informed. */}
            <div className="flex justify-center gap-1">
              {dashWindow?.blocks.map(b => (
                <div
                  key={b.blockNumber.toString()}
                  className={`h-3 w-8 rounded ${b.isGreen ? "bg-green-500" : "bg-red-600"}`}
                  title={`block ${b.blockNumber}`}
                />
              ))}
            </div>
            {actedThisBlock && <div className="text-center text-xs opacity-60">one step per block</div>}
          </div>
        )}
      </div>

      {/* Wallet + honest network state */}
      <div className="mt-4 space-y-1 text-center text-xs opacity-60">
        {burner.funding && <div className="text-amber-300">getting you testnet gas…</div>}
        {burner.fundingError && <div className="text-red-400">faucet: {burner.fundingError}</div>}
        {netWarning && <div className="text-amber-300">network busy — retrying</div>}
        {burner.balanceWei !== undefined && (
          <div>
            {Number(formatEther(burner.balanceWei)).toFixed(4)} MON · {burner.address?.slice(0, 6)}…
            {burner.address?.slice(-4)}
          </div>
        )}
        {burner.balanceWei === 0n && !burner.funding && (
          <button className="underline" onClick={() => burner.requestFunding()}>
            get gas
          </button>
        )}
        {round && <div>round {round.roundId}</div>}
      </div>
    </Shell>
  );
}

function decodeRevert(message: string): string | undefined {
  const match = message.match(/0x[0-9a-fA-F]{8,}/);
  if (!match) return undefined;
  try {
    const decoded = decodeErrorResult({ abi: RED_LIGHT_GREEN_BLOCK_ABI, data: match[0] as `0x${string}` });
    return decoded.errorName;
  } catch {
    return undefined;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-neutral-950 p-4 text-white">{children}</main>
  );
}

function BigButton({
  children,
  onClick,
  disabled,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full flex-1 flex-col items-center justify-center rounded-2xl px-4 py-6 text-2xl font-black tracking-tight transition active:scale-[0.98] disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

function Sub({ children }: { children: React.ReactNode }) {
  return <span className="mt-1 text-xs font-medium opacity-80">{children}</span>;
}
