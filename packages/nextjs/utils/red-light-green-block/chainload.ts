import { RpcPool } from "./rpc.ts";

/**
 * How busy the chain is, and how much of that is us.
 *
 * The claim this supports is deliberately narrow: a room playing this game generates far more
 * transactions than the rest of the testnet, WHILE BARELY TOUCHING BLOCK CAPACITY. Both halves
 * matter. The first is dramatic, the second is what keeps it honest — we are not stress-testing
 * Monad and must not imply we are.
 *
 * What this is NOT: a throughput benchmark. Monad's capacity is not being probed here and no TPS
 * figure derived from this means anything about the chain's limits. It measures a room, on a
 * nearly-idle testnet, and says so.
 */

export type ChainBaseline = {
  /** Blocks actually sampled. Reported so the figure can be weighed, not just quoted. */
  sampleSize: number;
  minTxPerBlock: number;
  medianTxPerBlock: number;
  maxTxPerBlock: number;
  meanTxPerBlock: number;
  /** Mean gasUsed as a percentage of the block gas limit. */
  meanFillPercent: number;
  meanGasUsed: number;
  gasLimit: number;
  sampledAt: number;
};

type RawBlock = { transactions: string[]; gasUsed: string; gasLimit: string; number: string };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Samples recent blocks to establish what the testnet looks like WITHOUT us.
 *
 * Sampled at startup rather than hardcoded, because a number baked into the source is a number
 * that silently becomes a lie. Sampling every other block spreads the window over roughly twice
 * the wall-clock time for the same request cost.
 */
export async function sampleBaseline(pool: RpcPool, blocks = 20): Promise<ChainBaseline | undefined> {
  try {
    const head = await pool.blockNumber();
    const numbers: bigint[] = [];
    for (let i = 0; i < blocks; i++) numbers.push(head - BigInt(i * 2));

    const results = await Promise.all(
      numbers.map(n =>
        pool.call<RawBlock | null>("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]).catch(() => null),
      ),
    );

    const sampled = results.filter((b): b is RawBlock => Boolean(b?.transactions));
    if (sampled.length === 0) return undefined;

    const txCounts = sampled.map(b => b.transactions.length);
    const gasUsed = sampled.map(b => Number(BigInt(b.gasUsed)));
    const gasLimit = Number(BigInt(sampled[0].gasLimit));

    const meanGasUsed = gasUsed.reduce((a, b) => a + b, 0) / gasUsed.length;

    return {
      sampleSize: sampled.length,
      minTxPerBlock: Math.min(...txCounts),
      medianTxPerBlock: median(txCounts),
      maxTxPerBlock: Math.max(...txCounts),
      meanTxPerBlock: txCounts.reduce((a, b) => a + b, 0) / txCounts.length,
      meanFillPercent: gasLimit > 0 ? (meanGasUsed / gasLimit) * 100 : 0,
      meanGasUsed,
      gasLimit,
      sampledAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

export type BlockLoad = {
  blockNumber: bigint;
  /** Every transaction in the block, ours and everyone else's. */
  totalTx: number;
  /** Moves this game produced in that block, counted from our contract's own logs. */
  gameMoves: number;
  /** totalTx - gameMoves, floored at zero. */
  otherTx: number;
  fillPercent: number;
};

/**
 * Combines a block's true transaction count with how many moves this game contributed.
 *
 * `gameMoves` comes from our contract's logs, so it counts SUCCESSFUL actions. A step that
 * reverted — a missed window, or a step into an already-finished round — emits nothing and is not
 * counted here, though it did occupy a slot in the block. So `otherTx` is an upper bound on other
 * people's traffic, and this understates rather than overstates our share. That is the direction
 * an honest estimate should err in.
 */
export function combineLoad(
  blockNumber: bigint,
  block: { totalTx: number; fillPercent: number },
  gameMoves: number,
): BlockLoad {
  return {
    blockNumber,
    totalTx: block.totalTx,
    gameMoves,
    otherTx: Math.max(0, block.totalTx - gameMoves),
    fillPercent: block.fillPercent,
  };
}

/**
 * How many times the game multiplied the chain's transaction rate, against the measured baseline.
 *
 * Returns `undefined` rather than a number when there is no baseline or the baseline is zero — an
 * unmeasurable ratio must not render as a confident "0x" or "Infinityx" on a projector.
 */
export function loadMultiple(gameMoves: number, baseline: ChainBaseline | undefined): number | undefined {
  if (!baseline || baseline.meanTxPerBlock <= 0 || gameMoves <= 0) return undefined;
  return (gameMoves + baseline.meanTxPerBlock) / baseline.meanTxPerBlock;
}
