import { RpcPool } from "./utils/red-light-green-block/rpc.ts";
import { createWalletClient, custom, defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const pool = new RpcPool({ pinSends: true });
console.log("pinned to:", pool.pinnedEndpoint);
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
const funder = privateKeyToAccount(process.argv[2] as `0x${string}`);
const client = createWalletClient({
  account: funder,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});

const bots = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
let nonce = await pool.transactionCount(funder.address, "pending");
console.log("start nonce:", nonce);
const hashes: string[] = [];
for (const b of bots) {
  try {
    const h = await client.sendTransaction({ to: b.address, value: 10000000000000000n, gas: 21000n, nonce: nonce });
    console.log(`  nonce ${nonce} -> ${h}`);
    hashes.push(h);
  } catch (e) {
    console.log(
      `  nonce ${nonce} FAILED: ${
        String(e)
          .split("\n")
          .find(l => l.includes("Details")) || String(e).slice(0, 120)
      }`,
    );
  }
  nonce++;
}
await new Promise(r => setTimeout(r, 6000));
for (let i = 0; i < hashes.length; i++) {
  const r = await pool.call<any>("eth_getTransactionReceipt", [hashes[i]]);
  console.log(
    `  ${hashes[i].slice(0, 12)} receipt: ${r ? "status " + r.status + " block " + parseInt(r.blockNumber, 16) : "NOT MINED"}`,
  );
}
for (const b of bots) console.log(`  bot ${b.address.slice(0, 10)} balance ${await pool.balance(b.address)}`);
