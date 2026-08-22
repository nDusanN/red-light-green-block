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
const client = createWalletClient({
  account: funder,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});
const gp = await pool.gasPrice();

async function trial(label: string, opts: { delayMs?: number; awaitReceipt?: boolean; legacy?: boolean }) {
  const bots = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
  let nonce = await pool.transactionCount(funder.address, "pending");
  const hashes: string[] = [];
  for (const b of bots) {
    const base: any = { to: b.address, value: 5000000000000000n, gas: 21000n, nonce };
    if (opts.legacy) base.gasPrice = gp * 2n;
    const h = await client.sendTransaction(base);
    hashes.push(h);
    nonce++;
    if (opts.awaitReceipt) await pub.waitForTransactionReceipt({ hash: h });
    else if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
  }
  await new Promise(r => setTimeout(r, 7000));
  let ok = 0;
  for (const h of hashes) {
    const r = await pool.call<any>("eth_getTransactionReceipt", [h]);
    if (r?.status === "0x1") ok++;
  }
  console.log(`${label}: ${ok}/4 succeeded`);
  return ok;
}

await trial("A: rapid, EIP-1559 (baseline)", {});
await trial("B: 400ms spacing", { delayMs: 400 });
await trial("C: await each receipt", { awaitReceipt: true });
await trial("D: rapid, LEGACY gasPrice", { legacy: true });
