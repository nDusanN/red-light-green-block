import { RpcPool } from "./utils/red-light-green-block/rpc.ts";
import { createPublicClient, createWalletClient, custom, defineChain, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pool = new RpcPool({ pinSends: true });
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
const pub = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz"), pollingInterval: 100 });
const funder = privateKeyToAccount(process.argv[2] as `0x${string}`);
const bal = await pool.balance(funder.address);
console.log("funder balance:", Number(bal) / 1e18, "MON");

const fees = await pub.estimateFeesPerGas();
console.log(
  "viem default maxFeePerGas:",
  Number(fees.maxFeePerGas) / 1e9,
  "gwei  priority:",
  Number(fees.maxPriorityFeePerGas) / 1e9,
  "gwei",
);
const gp = await pool.gasPrice();
console.log("eth_gasPrice:", Number(gp) / 1e9, "gwei");
console.log("reserve per tx at viem maxFee (21000 gas):", Number(21000n * fees.maxFeePerGas) / 1e18, "MON");

const client = createWalletClient({
  account: funder,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});

// TEST: explicit modest maxFeePerGas, 4 rapid sends
const bots = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
let nonce = await pool.transactionCount(funder.address, "pending");
const hashes: string[] = [];
console.log("\n-- sending 4 with explicit maxFeePerGas = gasPrice*2 --");
for (const b of bots) {
  const h = await client.sendTransaction({
    to: b.address,
    value: 10000000000000000n,
    gas: 21000n,
    nonce,
    maxFeePerGas: gp * 2n,
    maxPriorityFeePerGas: 1000000000n,
  });
  hashes.push(h);
  console.log(`  nonce ${nonce} -> ${h.slice(0, 14)}`);
  nonce++;
}
await new Promise(r => setTimeout(r, 6000));
let ok = 0;
for (const h of hashes) {
  const r = await pool.call<any>("eth_getTransactionReceipt", [h]);
  const st = r ? r.status : "none";
  if (st === "0x1") ok++;
  console.log(`  ${h.slice(0, 14)} -> ${st}`);
}
console.log(`RESULT: ${ok}/4 succeeded with explicit maxFeePerGas`);
