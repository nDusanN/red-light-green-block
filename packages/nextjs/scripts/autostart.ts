/**
 * Keeps a round running, all day, so anyone who walks up can play immediately.
 *
 * A round is 300 blocks (~91s) and `startRound()` is permissionless, so in principle the room
 * restarts it themselves. In practice a player who opens the page between rounds sees a START
 * button instead of a game, and at an event that reads as broken rather than as "press this".
 *
 * This is emphatically NOT a game server. It calls the same permissionless `startRound()` any
 * visitor can call, it holds no privileged position, and it cannot influence the light, admit or
 * eliminate anyone, or affect an in-flight round. If it dies, the game continues and the next
 * player to press the button restarts it. It exists purely so nobody has to.
 *
 * Usage:
 *   node --experimental-strip-types scripts/autostart.ts --address 0x... --key 0xPRIVKEY
 */
import { RED_LIGHT_GREEN_BLOCK_ABI } from "../utils/red-light-green-block/abi.ts";
import { START_ROUND_GAS_LIMIT } from "../utils/red-light-green-block/gas.ts";
import { RpcPool } from "../utils/red-light-green-block/rpc.ts";
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
import { privateKeyToAccount } from "viem/accounts";

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];

const RPC = args.rpc ?? "https://testnet-rpc.monad.xyz";
const ADDRESS = args.address as `0x${string}`;
const KEY = args.key as `0x${string}`;

if (!ADDRESS || !KEY) {
  console.error("Required: --address <contract> --key <private key>");
  process.exit(1);
}

const pool = new RpcPool({ pinSends: true });
const pub = createPublicClient({ transport: http(RPC), pollingInterval: 150 });
const chainId = await pub.getChainId();
const chain = defineChain({
  id: chainId,
  name: chainId === 10143 ? "Monad Testnet" : `chain ${chainId}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const account = privateKeyToAccount(KEY);
const client = createWalletClient({
  account,
  chain,
  transport: custom({ request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]) }),
});

console.log(`autostart: watching ${ADDRESS} as ${account.address}`);

async function roundInfo() {
  const raw = await pool.ethCall(
    ADDRESS,
    encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "getRoundInfo", args: [] }),
  );
  return decodeFunctionResult({
    abi: RED_LIGHT_GREEN_BLOCK_ABI,
    functionName: "getRoundInfo",
    data: raw as `0x${string}`,
  });
}

let started = 0;
let consecutiveFailures = 0;

for (;;) {
  try {
    const [roundId, , , active, , playerCount] = await roundInfo();

    if (!active) {
      const balance = await pool.balance(account.address);
      // Below the 10 MON reserve an account can only send a value-spending transaction every 3
      // blocks. startRound sends no value, but a wallet this low is about to become a problem
      // anyway, so say so loudly rather than failing quietly at 2am.
      if (balance < 10n ** 17n) {
        console.warn(`autostart: balance ${formatEther(balance)} MON is very low; top it up`);
      }

      const hash = await client.sendTransaction({
        to: ADDRESS,
        data: encodeFunctionData({ abi: RED_LIGHT_GREEN_BLOCK_ABI, functionName: "startRound", args: [] }),
        gas: START_ROUND_GAS_LIMIT,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash });

      if (receipt.status === "success") {
        started++;
        const [newId] = await roundInfo();
        console.log(
          `autostart: started round ${newId} (previous ${roundId} had ${playerCount} players) [${started} total]`,
        );
        consecutiveFailures = 0;
      } else {
        // Almost always a harmless race: somebody else started the round first.
        consecutiveFailures++;
      }
    }
  } catch (error) {
    consecutiveFailures++;
    if (consecutiveFailures <= 3 || consecutiveFailures % 20 === 0) {
      console.warn(`autostart: ${String(error).slice(0, 120)}`);
    }
  }

  // Poll about twice a second: fast enough that the gap between rounds is imperceptible, slow
  // enough that this costs a negligible slice of the shared rate limit.
  await new Promise(r => setTimeout(r, 600));
}
