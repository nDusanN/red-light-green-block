/**
 * Headless multi-wallet playtest.
 *
 * Two jobs in one script:
 *
 *   1. END-TO-END PROOF. It drives the real client stack -- the same `lightAt`, the same declared
 *      gas limits, the same RPC pool -- so a green run means the loop genuinely works, not that a
 *      UI rendered without crashing.
 *   2. LOAD MEASUREMENT. It reports the numbers that decide whether a room full of players
 *      survives: observed HTTP 429 rate, inclusion latency, and how many steps actually landed.
 *
 * It reports what happened rather than asserting success. A run where half the steps were
 * throttled is a finding, not a failure, and hiding it would defeat the point of running it.
 *
 * Usage:
 *   node --experimental-strip-types scripts/playtest.ts \
 *     --rpc http://127.0.0.1:8545 --address 0x... --funder 0xPRIVKEY --bots 5
 */
import { RED_LIGHT_GREEN_BLOCK_ABI } from "../utils/red-light-green-block/abi.ts";
import { JOIN_GAS_LIMIT, START_ROUND_GAS_LIMIT, stepGasLimit } from "../utils/red-light-green-block/gas.ts";
import { TRACK_LENGTH, lightAt, stepWindow } from "../utils/red-light-green-block/light.ts";
import { DEFAULT_HTTP_ENDPOINTS, RpcPool } from "../utils/red-light-green-block/rpc.ts";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionResult,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type Args = Record<string, string>;

function parseArgs(): Args {
  const out: Args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    out[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
  }
  return out;
}

const args = parseArgs();
const RPC = args.rpc ?? "https://testnet-rpc.monad.xyz";
const ADDRESS = args.address as `0x${string}`;
const FUNDER = args.funder as `0x${string}`;
const BOTS = Number(args.bots ?? 5);
/** Fraction of steps taken as DASH rather than SAFE, so both paths get exercised. */
const DASH_RATE = Number(args.dashRate ?? 0.35);
const MAX_SECONDS = Number(args.seconds ?? 90);
/**
 * Fraction of steps taken even when the window is not certainly green.
 *
 * Without this, bots only ever step into guaranteed-green windows and never die, so the run
 * exercises none of the elimination path and reports a survival rate no human would achieve.
 * Real players mistime moves; this makes the load figures reflect that.
 */
const RECKLESS_RATE = Number(args.recklessRate ?? 0.2);

if (!ADDRESS || !FUNDER) {
  console.error("Required: --address <contract> --funder <private key>");
  process.exit(1);
}

/** A local single node has no pool to spread across; a testnet run uses the full weighted pool. */
const isLocal = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const pool = new RpcPool({
  endpoints: isLocal ? [{ url: RPC, weight: 1 }] : DEFAULT_HTTP_ENDPOINTS,
  maxAttempts: 6,
});

const transport = custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) });
// pollingInterval matters for the numbers this script prints. viem defaults to 4000ms, which on a
// 305ms chain means every "inclusion latency" reading would be a measurement of viem's polling
// loop rather than of the chain. 100ms is well below the block time, so what is reported is
// dominated by real inclusion.
const publicClient = createPublicClient({ transport: http(RPC), pollingInterval: 100 });

const stats = {
  joins: 0,
  joinFailures: 0,
  stepsSent: 0,
  stepsLanded: 0,
  eliminated: 0,
  missedWindow: 0,
  alreadyActed: 0,
  sendErrors: 0,
  wins: 0,
  inclusionMs: [] as number[],
};

const chainId = await publicClient.getChainId();
console.log(`playtest: ${BOTS} bots against ${RPC} (chain ${chainId}), contract ${ADDRESS}`);

// Built from whatever chain actually answered, so the same script drives a local Anvil and the
// real testnet without a flag saying which is which.
const chain = defineChain({
  id: chainId,
  name: chainId === 10143 ? "Monad Testnet" : `chain ${chainId}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const funder = privateKeyToAccount(FUNDER);
const funderClient = createWalletClient({ account: funder, transport, chain });

async function readRound() {
  const raw = await pool.ethCall(
    ADDRESS,
    encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getRoundInfo", args: [] }),
  );
  const [roundId, startBlock, endBlock, active, winner, playerCount] = decodeFunctionResult({
    abi: RED_LIGHT_GREEN_BLOCK_ABI,
    functionName: "getRoundInfo",
    data: raw as `0x${string}`,
  });
  return {
    roundId: Number(roundId),
    startBlock: BigInt(startBlock),
    endBlock: BigInt(endBlock),
    active,
    winner,
    playerCount: Number(playerCount),
  };
}

// ---- Fund the bots ------------------------------------------------------
// Sequential nonces, no receipt waits between sends: the same discipline the faucet route uses,
// for the same reason -- at ~305ms blocks, awaiting receipts would serialise setup pointlessly.
const bots = Array.from({ length: BOTS }, () => privateKeyToAccount(generatePrivateKey()));
const gasPrice = await pool.gasPrice();
const fundEach = (JOIN_GAS_LIMIT + BigInt(TRACK_LENGTH) * stepGasLimit(0, TRACK_LENGTH)) * gasPrice * 2n;

console.log(`funding ${BOTS} bots with ${formatEther(fundEach)} MON each...`);
let nonce = await pool.transactionCount(funder.address, "pending");
let lastFundHash: `0x${string}` | undefined;
for (const bot of bots) {
  lastFundHash = await funderClient.sendTransaction({
    to: bot.address,
    value: fundEach,
    gas: 21_000n,
    nonce: nonce++,
  });
}
if (lastFundHash) await publicClient.waitForTransactionReceipt({ hash: lastFundHash });
console.log("funded.");

// ---- Make sure a round is live -----------------------------------------
let round = await readRound();
if (!round.active) {
  console.log("no active round, starting one...");
  const client = createWalletClient({ account: bots[0], transport, chain });
  const hash = await client.sendTransaction({
    to: ADDRESS,
    data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "startRound", args: [] }),
    gas: START_ROUND_GAS_LIMIT,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  round = await readRound();
}
console.log(`round ${round.roundId}, anchor block ${round.startBlock}, ends ${round.endBlock}`);

// ---- Each bot plays independently ---------------------------------------
async function runBot(account: (typeof bots)[number], index: number) {
  const client = createWalletClient({ account, transport, chain });
  let pos = 0;
  let alive = true;
  let joined = false;
  let lastActedBlock = -1n;

  const deadline = Date.now() + MAX_SECONDS * 1000;

  while (Date.now() < deadline && alive) {
    let block: bigint;
    try {
      block = await pool.blockNumber();
    } catch {
      continue;
    }

    if (block > round.endBlock) break;
    if (block === lastActedBlock) {
      await new Promise(r => setTimeout(r, 60));
      continue;
    }

    if (!joined) {
      try {
        const hash = await client.sendTransaction({
          to: ADDRESS,
          data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "join", args: [] }),
          gas: JOIN_GAS_LIMIT,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        joined = true;
        stats.joins++;
        lastActedBlock = block;
      } catch (error) {
        stats.joinFailures++;
        if (!/AlreadyJoined/i.test(String(error))) console.log(`  bot ${index} join failed: ${error}`);
        joined = true;
      }
      continue;
    }

    // A bot plays the way we want a human to: it looks at the window before choosing.
    const dash = Math.random() < DASH_RATE;
    const lookahead = dash ? 4n : 1n;
    const window = stepWindow(round.roundId, round.startBlock, block, block + lookahead);

    // Normally only step into a survivable window, but sometimes take the risk anyway, so the
    // elimination path is genuinely exercised rather than assumed to work.
    const reckless = Math.random() < RECKLESS_RATE;
    if (!window.allGreen && !reckless) {
      await new Promise(r => setTimeout(r, 80));
      continue;
    }

    lastActedBlock = block;
    const sentAt = Date.now();
    stats.stepsSent++;

    try {
      const hash = await client.sendTransaction({
        to: ADDRESS,
        data: encodeFunctionData({
          abi: RED_LIGHT_GREEN_BLOCK_ABI,
          functionName: "step",
          args: [Number(block + lookahead)],
        }),
        gas: stepGasLimit(pos, TRACK_LENGTH),
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      stats.inclusionMs.push(Date.now() - sentAt);

      if (receipt.status === "success") {
        // A successful transaction is not a successful step: a red landing also succeeds.
        if (lightAt(round.roundId, round.startBlock, receipt.blockNumber)) {
          pos++;
          stats.stepsLanded++;
          if (pos >= TRACK_LENGTH) {
            stats.wins++;
            console.log(`  bot ${index} WON in block ${receipt.blockNumber}`);
            alive = false;
          }
        } else {
          alive = false;
          stats.eliminated++;
          console.log(`  bot ${index} eliminated at step ${pos} (landed red in ${receipt.blockNumber})`);
        }
      } else {
        stats.missedWindow++;
      }
    } catch (error) {
      const text = String(error);
      if (/StepWindowMissed/i.test(text)) stats.missedWindow++;
      else if (/AlreadyActedThisBlock/i.test(text)) stats.alreadyActed++;
      else {
        stats.sendErrors++;
        if (stats.sendErrors < 5) console.log(`  bot ${index} send error: ${text.slice(0, 140)}`);
      }
    }
  }

  return { index, pos, alive };
}

const started = Date.now();
const results = await Promise.all(bots.map((bot, i) => runBot(bot, i)));
const elapsed = (Date.now() - started) / 1000;

// ---- Report -------------------------------------------------------------
const inclusion = stats.inclusionMs.sort((a, b) => a - b);
const q = (f: number) =>
  inclusion.length ? inclusion[Math.min(inclusion.length - 1, Math.floor(inclusion.length * f))] : 0;

console.log("\n================ PLAYTEST RESULT ================");
console.log(`bots                 ${BOTS}`);
console.log(`wall clock           ${elapsed.toFixed(1)}s`);
console.log(`joins                ${stats.joins} (${stats.joinFailures} failed)`);
console.log(`steps sent           ${stats.stepsSent}`);
console.log(`steps landed green   ${stats.stepsLanded}`);
console.log(`eliminated on red    ${stats.eliminated}`);
console.log(`wins                 ${stats.wins}`);
console.log(`missed window        ${stats.missedWindow}  (declined, player survives)`);
console.log(`already-acted revert ${stats.alreadyActed}`);
console.log(`send errors          ${stats.sendErrors}`);
console.log(`furthest position    ${Math.max(...results.map(r => r.pos))} / ${TRACK_LENGTH}`);
console.log("--- inclusion latency (send -> receipt) ---");
console.log(`p50 ${q(0.5)}ms   p90 ${q(0.9)}ms   max ${inclusion[inclusion.length - 1] ?? 0}ms`);
console.log("--- rpc pool ---");
console.log(
  `requests ${pool.stats.requests}  retries ${pool.stats.retries}  throttled(429/503) ${pool.stats.throttled}  hard failures ${pool.stats.failures}`,
);
const throttleRate = pool.stats.requests ? (pool.stats.throttled / pool.stats.requests) * 100 : 0;
console.log(`observed throttle rate ${throttleRate.toFixed(2)}%`);
console.log("================================================");

if (throttleRate > 3) {
  console.log("\nWARNING: throttle rate above 3%. The mitigation is not good enough for a full room.");
}
