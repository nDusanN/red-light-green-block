import { RED_LIGHT_GREEN_BLOCK_ABI } from "./utils/red-light-green-block/abi.ts";
import { JOIN_GAS_LIMIT, STEP_GAS_LIMIT } from "./utils/red-light-green-block/gas.ts";
import { RpcPool } from "./utils/red-light-green-block/rpc.ts";
import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ADDR = "0x407a47b8EBfd168bdA6B8D38243cf62Bad598003" as const;
const pool = new RpcPool({ pinSends: true });
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
const pub = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz"), pollingInterval: 100 });
const funder = privateKeyToAccount(process.argv[2] as `0x${string}`);
const fc = createWalletClient({
  account: funder,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});

const bot = privateKeyToAccount(generatePrivateKey());
console.log("bot:", bot.address);
const fh = await fc.sendTransaction({ to: bot.address, value: 200000000000000000n, gas: 21000n });
const fr = await pub.waitForTransactionReceipt({ hash: fh });
console.log(
  "funding status:",
  fr.status,
  " bot balance:",
  Number(await pool.balance(bot.address)) / 1e18,
  "MON (well below the 10 MON reserve)",
);

const bc = createWalletClient({
  account: bot,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});

// Ensure a round exists
const [, , , active] = await (async () => {
  const { decodeFunctionResult } = await import("viem");
  const raw = await pool.ethCall(
    ADDR,
    encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getRoundInfo", args: [] }),
  );
  return decodeFunctionResult({
    abi: RED_LIGHT_GREEN_BLOCK_ABI,
    functionName: "getRoundInfo",
    data: raw as `0x${string}`,
  });
})();
if (!active) {
  console.log("starting round...");
  const h = await bc.sendTransaction({
    to: ADDR,
    data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "startRound", args: [] }),
    gas: 76166n,
  });
  console.log("startRound:", (await pub.waitForTransactionReceipt({ hash: h })).status);
}

const jh = await bc.sendTransaction({
  to: ADDR,
  data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "join", args: [] }),
  gas: JOIN_GAS_LIMIT,
});
console.log("join status:", (await pub.waitForTransactionReceipt({ hash: jh })).status);

// THE TEST: 3 rapid step() calls, value = 0, no waiting between sends.
console.log("\n-- 3 rapid step() calls, value=0, no spacing --");
const blk = await pool.blockNumber();
const hashes: string[] = [];
let n = await pool.transactionCount(bot.address, "pending");
for (let i = 0; i < 3; i++) {
  try {
    const h = await bc.sendTransaction({
      to: ADDR,
      data: encodeFunctionData({
        abi: RED_LIGHT_GREEN_BLOCK_ABI,
        functionName: "step",
        args: [Number(blk + BigInt(6 + i * 3))],
      }),
      gas: STEP_GAS_LIMIT,
      nonce: n++,
    });
    hashes.push(h);
    console.log(`  sent step ${i + 1}`);
  } catch (e) {
    console.log(
      `  step ${i + 1} SEND REJECTED: ${String(e)
        .split("\n")
        .find(l => l.includes("Details"))
        ?.trim()}`,
    );
  }
}
await new Promise(r => setTimeout(r, 8000));
for (let i = 0; i < hashes.length; i++) {
  const r = await pool.call<any>("eth_getTransactionReceipt", [hashes[i]]);
  console.log(`  step ${i + 1}: ${r ? "status " + r.status + " gasUsed " + parseInt(r.gasUsed, 16) : "NOT MINED"}`);
}
const raw = await pool.ethCall(
  ADDR,
  encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getPlayer", args: [bot.address] }),
);
const { decodeFunctionResult } = await import("viem");
console.log(
  "final player state:",
  decodeFunctionResult({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getPlayer", data: raw as `0x${string}` }),
);
