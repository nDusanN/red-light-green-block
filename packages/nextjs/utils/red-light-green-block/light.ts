import { encodeAbiParameters, keccak256 } from "viem";

/**
 * TypeScript port of the light schedule in
 * `packages/foundry/contracts/RedLightGreenBlock.sol`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The contract is the referee, but clients must never ask it what colour the light is. Monad's
 * public RPC rate-limits per IP, and at a live event a whole room shares one NAT, so every read a
 * phone makes is a transaction some other phone cannot send. The light is therefore computed here,
 * locally, from values that are fetched once per round and never change.
 *
 * WHY THIS IS DANGEROUS
 * ---------------------
 * Two implementations of the same rule will drift unless something forces them not to. If this
 * file disagreed with the contract by even one block, players would see a green light, step, and
 * be eliminated by a chain that saw red. The game would look broken and rigged at the same time.
 *
 * So this is not trusted on inspection. `light.test.ts` and `LightFixtureParity.t.sol` both check
 * themselves against the same committed fixture — the TypeScript in Node, the Solidity in Foundry
 * — so neither implementation can move without the other being caught. Regenerate the fixture
 * with `yarn foundry:light-fixture`.
 *
 * Every constant below must equal the Solidity constant of the same name.
 */

/** Blocks in one full green-then-red cycle. 40 blocks = 12.0s at the measured 304.8ms/block. */
export const CYCLE_LENGTH_BLOCKS = 40n;

/** Fewest green blocks at the start of a cycle. 12 blocks = 3.7s. */
export const MIN_GREEN_BLOCKS = 12n;

/** Most green blocks at the start of a cycle. 30 blocks = 9.1s. */
export const MAX_GREEN_BLOCKS = 30n;

/** Steps needed to win. Kept short deliberately: see the TRACK_LENGTH NatSpec in the contract. */
export const TRACK_LENGTH = 20;

/** Blocks a round lasts. 300 blocks = 91 seconds at the measured 304.8ms/block. */
export const ROUND_LENGTH_BLOCKS = 300n;

const GREEN_SPAN = MAX_GREEN_BLOCKS - MIN_GREEN_BLOCKS + 1n;

/**
 * Memoises the per-cycle green length.
 *
 * A round is 1200 blocks = 30 cycles, so this stays tiny, but it is worth having: the stage view
 * re-renders every 300ms and asks for the light across many blocks at once, and a keccak256 per
 * lookup per frame is avoidable work. Keyed by round so a new round cannot read stale entries.
 */
const greenLengthCache = new Map<string, bigint>();

/**
 * How many blocks at the start of `cycleIndex` are green.
 *
 * Mirrors `greenBlocksInCycle` in Solidity. The ABI encoding matters as much as the arithmetic:
 * Solidity hashes `abi.encode(uint32 roundId, uint256 cycleIndex)`, which is two 32-byte
 * left-padded words. Encoding these any other way — packed, or with different widths — produces a
 * different hash and a silently different schedule.
 */
export function greenBlocksInCycle(roundId: number, cycleIndex: bigint): bigint {
  const key = `${roundId}:${cycleIndex}`;
  const cached = greenLengthCache.get(key);
  if (cached !== undefined) return cached;

  const hash = keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }], [roundId, cycleIndex]));
  const value = MIN_GREEN_BLOCKS + (BigInt(hash) % GREEN_SPAN);

  greenLengthCache.set(key, value);
  return value;
}

/**
 * The traffic light for `blockNumber`. `true` means a step landing in that block advances.
 *
 * Mirrors `lightAt` in Solidity, including its convention that blocks before the round started
 * report green — no step can execute in those, so it only affects how charts render.
 */
export function lightAt(roundId: number, roundStartBlock: bigint, blockNumber: bigint): boolean {
  if (blockNumber < roundStartBlock) return true;

  const elapsed = blockNumber - roundStartBlock;
  return elapsed % CYCLE_LENGTH_BLOCKS < greenBlocksInCycle(roundId, elapsed / CYCLE_LENGTH_BLOCKS);
}

/**
 * The next block strictly after `blockNumber` whose colour differs from `blockNumber`'s.
 *
 * Mirrors `nextLightChangeAfter` in Solidity. This is what lets the UI say "green for 3 more
 * blocks" without asking the chain anything.
 */
export function nextLightChangeAfter(roundId: number, roundStartBlock: bigint, blockNumber: bigint): bigint {
  if (blockNumber < roundStartBlock) return roundStartBlock;

  const elapsed = blockNumber - roundStartBlock;
  const cycleIndex = elapsed / CYCLE_LENGTH_BLOCKS;
  const cycleStart = roundStartBlock + cycleIndex * CYCLE_LENGTH_BLOCKS;
  const green = greenBlocksInCycle(roundId, cycleIndex);

  if (elapsed % CYCLE_LENGTH_BLOCKS < green) return cycleStart + green;
  return cycleStart + CYCLE_LENGTH_BLOCKS;
}

/** How many blocks the current colour has left, counting `blockNumber` itself as one. */
export function blocksUntilLightChange(roundId: number, roundStartBlock: bigint, blockNumber: bigint): bigint {
  return nextLightChangeAfter(roundId, roundStartBlock, blockNumber) - blockNumber;
}

export type WindowBlock = { blockNumber: bigint; isGreen: boolean };

/**
 * The colour of every block a step could land in, given the deadline the player is about to
 * declare.
 *
 * This is the whole game reduced to a number, and it is why the deadline is worth having: the
 * player is not guessing, they are choosing between windows whose contents they can already see.
 *
 * The window is `[currentBlock + 1, maxBlock]`. It starts at the NEXT block because `currentBlock`
 * has already been produced by the time the client knows its number, so a transaction sent now
 * cannot land in it. That is an assumption about the client's view of the chain, not a rule the
 * contract enforces — the contract accepts execution in any block up to and including `maxBlock`,
 * so a transaction that did land in `currentBlock` would be honoured. Treating the window as
 * starting one block later is the conservative reading and never understates risk.
 */
export function stepWindow(
  roundId: number,
  roundStartBlock: bigint,
  currentBlock: bigint,
  maxBlock: bigint,
): { blocks: WindowBlock[]; allGreen: boolean; redCount: number } {
  const blocks: WindowBlock[] = [];

  for (let b = currentBlock + 1n; b <= maxBlock; b++) {
    blocks.push({ blockNumber: b, isGreen: lightAt(roundId, roundStartBlock, b) });
  }

  const redCount = blocks.filter(b => !b.isGreen).length;
  return { blocks, allGreen: blocks.length > 0 && redCount === 0, redCount };
}

export type LightRun = { startBlock: bigint; endBlock: bigint; isGreen: boolean };

/**
 * The schedule for a span of blocks, collapsed into runs of a single colour.
 *
 * Returned as runs rather than per-block so the stage view can draw a whole round as a few dozen
 * bars instead of 1200 elements.
 */
export function lightRuns(roundId: number, roundStartBlock: bigint, fromBlock: bigint, toBlock: bigint): LightRun[] {
  if (toBlock < fromBlock) return [];

  const runs: LightRun[] = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const isGreen = lightAt(roundId, roundStartBlock, cursor);
    const change = nextLightChangeAfter(roundId, roundStartBlock, cursor);
    const endBlock = change - 1n > toBlock ? toBlock : change - 1n;

    runs.push({ startBlock: cursor, endBlock, isGreen });
    cursor = endBlock + 1n;
  }

  return runs;
}
