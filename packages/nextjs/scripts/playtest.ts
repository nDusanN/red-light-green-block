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
import { RpcPool } from "../utils/red-light-green-block/rpc.ts";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
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

/**
 * A local single node has no pool to spread across. A testnet run uses the pool's own defaults,
 * which deliberately split sends from reads -- passing an explicit endpoint list here would
 * override that split and send eth_call to drpc, which refuses every one of them.
 */
const isLocal = RPC.includes("127.0.0.1") || RPC.includes("localhost");
const pool = isLocal
  ? new RpcPool({ endpoints: [{ url: RPC, weight: 1 }], maxAttempts: 6 })
  : new RpcPool({ maxAttempts: 6 });

/**
 * Separate pool for the funding loop, pinned to one endpoint.
 *
 * The funder assigns its own sequential nonces, and endpoints do not share a mempool, so
 * round-robining a nonce run leaves every host with a sequence it cannot complete. Bots then fail
 * with "Signer had insufficient balance" -- a symptom that points at the wrong thing entirely.
 */
const funderPool = isLocal ? pool : new RpcPool({ maxAttempts: 6, pinSends: true });

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
  roundNotActive: 0,
  alreadyActed: 0,
  sendErrors: 0,
  wins: 0,
  roundsStarted: 0,
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
const funderTransport = custom({
  request: ({ method, params }) => funderPool.call(method, (params ?? []) as unknown[]),
});
const funderClient = createWalletClient({ account: funder, transport: funderTransport, chain });

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
// Each funding transaction is awaited AND its status checked before the next is sent.
//
// Two separate traps here, both of which silently produced unfunded wallets:
//   1. Firing them back to back is what a 305ms chain invites, but on real Monad testnet only the
//      first reliably lands; the rest are mined with status 0. Measured: rapid 1-2/4, awaited 4/4.
//   2. viem's waitForTransactionReceipt resolves on a REVERTED receipt just as happily as a
//      successful one. Awaiting it without checking `status` looks like careful code and proves
//      nothing at all.
for (const bot of bots) {
  let funded = false;
  for (let attempt = 1; attempt <= 3 && !funded; attempt++) {
    // Re-read the nonce each attempt rather than tracking it locally: after a failure the local
    // value and the chain's can disagree, and a wrong nonce fails the next several sends too.
    const nonce = await funderPool.transactionCount(funder.address, "pending");
    const hash = await funderClient.sendTransaction({
      to: bot.address,
      value: fundEach,
      gas: 21_000n,
      nonce,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    funded = receipt.status === "success";
    if (!funded) console.log(`  funding ${bot.address.slice(0, 10)} attempt ${attempt} reverted, retrying`);
  }
  if (!funded) console.log(`  WARNING: could not fund ${bot.address}`);
}

// Verify rather than assume. Awaiting only the last funding receipt is not proof the others
// landed, and a bot that starts unfunded fails later with "Signer had insufficient balance" --
// which points at the wrong thing entirely and cost real time to chase.
const fundDeadline = Date.now() + 30_000;
let fundedCount = 0;
while (Date.now() < fundDeadline) {
  const balances = await Promise.all(bots.map(bot => pool.balance(bot.address).catch(() => 0n)));
  fundedCount = balances.filter(b => b > 0n).length;
  if (fundedCount === bots.length) break;
  await new Promise(r => setTimeout(r, 1000));
}
if (fundedCount !== bots.length) {
  console.error(`FUNDING FAILED: only ${fundedCount}/${bots.length} bots have a balance. Aborting.`);
  process.exit(1);
}
console.log(`funded and verified: ${fundedCount}/${bots.length}`);

// Wait for consensus to SEE the funding, which is not the same as it having executed.
//
// Monad's consensus validates blocks against state from k=3 blocks ago, and an account's gas
// budget is min(10 MON, balance in that lagged state). A wallet funded a moment ago still looks
// empty to consensus, so its first transaction is rejected outright with "Signer had insufficient
// balance" -- even though eth_getBalance already reports the funds and a receipt already exists.
// Waiting for the receipt is necessary and not sufficient.
await new Promise(r => setTimeout(r, 2500));
console.log("waited for consensus to see the funding (k=3 block lag)");

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
/** Re-simulates a join to recover the custom error name behind a reverted receipt. */
async function joinRevertReason(from: string): Promise<string | undefined> {
  try {
    await pool.call("eth_call", [
      {
        from,
        to: ADDRESS,
        data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "join", args: [] }),
      },
      "latest",
    ]);
    return "no revert on simulation";
  } catch (error) {
    const text = String(error);
    for (const name of ["RoundNotActive", "AlreadyJoined"]) if (text.includes(name)) return name;
    const match = text.match(/0x[0-9a-fA-F]{8}/);
    if (match) {
      try {
        return decodeErrorResult({ abi: RED_LIGHT_GREEN_BLOCK_ABI, data: match[0] as `0x${string}` }).errorName;
      } catch {
        return text.slice(0, 120);
      }
    }
    return text.slice(0, 120);
  }
}

/** Re-simulates a step to recover the custom error name behind a reverted receipt. */
async function revertReason(from: string, maxBlock: bigint): Promise<string | undefined> {
  try {
    await pool.call("eth_call", [
      {
        from,
        to: ADDRESS,
        data: encodeFunctionData({
          abi: RED_LIGHT_GREEN_BLOCK_ABI,
          functionName: "step",
          args: [Number(maxBlock)],
        }),
      },
      "latest",
    ]);
    return undefined;
  } catch (error) {
    const text = String(error);
    for (const name of [
      "RoundNotActive",
      "StepWindowMissed",
      "AlreadyActedThisBlock",
      "NotJoined",
      "PlayerEliminated",
    ]) {
      if (text.includes(name)) return name;
    }
    const match = text.match(/0x[0-9a-fA-F]{8}/);
    if (match) {
      try {
        return decodeErrorResult({ abi: RED_LIGHT_GREEN_BLOCK_ABI, data: match[0] as `0x${string}` }).errorName;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

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

    // A round is only 300 blocks (~91s). Without this the bots keep stepping into a dead round and
    // every revert gets miscounted as a missed window, which hides the real result completely.
    if (block > round.endBlock) {
      if (index === 0) {
        try {
          const hash = await client.sendTransaction({
            to: ADDRESS,
            data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "startRound", args: [] }),
            gas: START_ROUND_GAS_LIMIT,
          });
          await publicClient.waitForTransactionReceipt({ hash });
          round = await readRound();
          console.log(`  round expired; started round ${round.roundId}`);
          stats.roundsStarted++;
        } catch {
          await new Promise(r => setTimeout(r, 500));
        }
      } else {
        await new Promise(r => setTimeout(r, 800));
        round = await readRound();
      }
      joined = false;
      pos = 0;
      continue;
    }
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
        // Check the STATUS, not just that a receipt exists. Counting a reverted join as a success
        // made every subsequent step fail with NotJoined, which then showed up as 93 "missed
        // windows" and sent me hunting a step-timing problem that did not exist.
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          stats.joinFailures++;
          if (stats.joinFailures <= 3) {
            const why = await joinRevertReason(account.address);
            console.log(`  bot ${index} join REVERTED (${why ?? "unknown"}) in block ${receipt.blockNumber}`);
          }
          await new Promise(r => setTimeout(r, 700));
          continue;
        }
        joined = true;
        stats.joins++;
        lastActedBlock = block;
      } catch (error) {
        stats.joinFailures++;
        if (!/AlreadyJoined/i.test(String(error)))
          console.log(`  bot ${index} join failed: ${String(error).slice(0, 700)}`);
        joined = true;
      }
      continue;
    }

    // A bot plays the way we want a human to: it looks at the window before choosing.
    // Same lookaheads the phone UI uses. 1 and 4 were unplayable: a client cannot observe blocks
    // as fast as they are produced, so the observed number is routinely 1-2 blocks stale and a
    // window of +1 is often already in the past by the time the transaction is signed.
    const dash = Math.random() < DASH_RATE;
    const lookahead = dash ? 12n : 6n;
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
        // A reverted receipt says nothing about WHY. Re-simulate the same call at the block it
        // landed in to recover the custom error, rather than blaming the step window for every
        // failure -- which is exactly what hid a round-expiry problem behind a plausible-looking
        // "missed window" count.
        const reason = await revertReason(account.address, block + lookahead);
        if (reason === "RoundNotActive") stats.roundNotActive++;
        else if (reason === "AlreadyActedThisBlock") stats.alreadyActed++;
        else stats.missedWindow++;
      }
    } catch (error) {
      const text = String(error);
      if (/StepWindowMissed/i.test(text)) stats.missedWindow++;
      else if (/AlreadyActedThisBlock/i.test(text)) stats.alreadyActed++;
      else {
        stats.sendErrors++;
        if (stats.sendErrors < 3) console.log(`  bot ${index} send error: ${text.slice(0, 700)}`);
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
console.log(`round not active     ${stats.roundNotActive}`);
console.log(`rounds started       ${stats.roundsStarted}`);
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
