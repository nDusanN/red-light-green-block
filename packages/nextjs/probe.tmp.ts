import { RED_LIGHT_GREEN_BLOCK_ABI } from "./utils/red-light-green-block/abi.ts";
import { JOIN_GAS_LIMIT } from "./utils/red-light-green-block/gas.ts";
import { RpcPool } from "./utils/red-light-green-block/rpc.ts";
import { createWalletClient, custom, defineChain, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ADDR = "0x407a47b8EBfd168bdA6B8D38243cf62Bad598003" as const;
const pool = new RpcPool();
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});

const funder = privateKeyToAccount(process.argv[2] as `0x${string}`);
const bot = privateKeyToAccount(generatePrivateKey());
const fc = createWalletClient({
  account: funder,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});
console.log("funding", bot.address);
const h = await fc.sendTransaction({ to: bot.address, value: 200000000000000000n, gas: 21000n });
console.log("fund tx", h);
await new Promise(r => setTimeout(r, 3000));
console.log("balance", await pool.balance(bot.address));

const bc = createWalletClient({
  account: bot,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
  chain,
});
try {
  const jh = await bc.sendTransaction({
    to: ADDR,
    data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "join", args: [] }),
    gas: JOIN_GAS_LIMIT,
  });
  console.log("JOIN OK", jh);
} catch (e) {
  console.log("JOIN FAILED:");
  console.log(String(e).slice(0, 2000));
}
