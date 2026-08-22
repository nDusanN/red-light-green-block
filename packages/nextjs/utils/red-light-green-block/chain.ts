import { RpcPool } from "./rpc.ts";
import { type Chain, defineChain } from "viem";

/**
 * The chain the app is actually talking to, detected from the configured RPC rather than assumed.
 *
 * Hardcoding `monadTestnet` seemed obviously right and was wrong twice over: it breaks against a
 * local Anvil, and it would silently break against a fork or any other endpoint someone points
 * `NEXT_PUBLIC_RLGB_RPC_URLS` at. viem rejects the mismatch at signing time with "invalid chain id
 * for signer", which surfaces as an opaque RPC error rather than as a configuration problem.
 *
 * Detecting instead means the same code runs against testnet, a fork, or Anvil with no flag saying
 * which. The result is cached because it cannot change for the lifetime of a page or a server
 * process, and one `eth_chainId` per process is a cost worth paying once.
 */

let cached: Promise<Chain> | undefined;

export function detectChain(pool: RpcPool): Promise<Chain> {
  if (!cached) {
    cached = pool.call<string>("eth_chainId").then(hex => {
      const id = Number(BigInt(hex));
      return defineChain({
        id,
        name: id === 10143 ? "Monad Testnet" : `chain ${id}`,
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: [] } },
      });
    });
    // Do not cache a failure: a transient RPC error at startup would otherwise poison every send
    // for the rest of the process.
    cached.catch(() => {
      cached = undefined;
    });
  }
  return cached;
}
