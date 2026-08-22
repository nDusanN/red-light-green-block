/**
 * RPC endpoint pool for Red Light, Green Block.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Rate limits on the public Monad testnet endpoints are per IP, and at a venue the whole room is
 * behind one NAT. So the room does not get 50 players' worth of budget — it gets one IP's worth,
 * shared. A burst of 60 concurrent requests was measured against each public endpoint:
 *
 *   https://monad-testnet.drpc.org        60 ok /  0 rejected   <- absorbed the whole burst
 *   https://testnet-rpc.monad.xyz         45 ok / 15 x HTTP 429
 *   https://rpc.ankr.com/monad_testnet    30 ok / 30 x HTTP 429
 *   https://rpc-testnet.monadinfra.com    20 ok / 40 x HTTP 429
 *
 * A 429 on `eth_sendRawTransaction` means the player's tap silently does nothing. Half a room
 * tapping at a dead button is the single most likely way this demo dies, and it looks like a
 * broken game rather than a busy network.
 *
 * WHAT THIS DOES ABOUT IT
 * -----------------------
 * - Spreads requests across several endpoints, weighted toward the one that survived the burst.
 * - Picks per REQUEST, not per session, so load spreads evenly instead of every phone that loaded
 *   the page at the same moment hammering the same host.
 * - Retries a 429 on a DIFFERENT endpoint, with exponential backoff and jitter. Jitter matters:
 *   without it, everyone who got throttled by the same block retries in lockstep and throttles
 *   again together.
 * - Never swallows a failure. The caller is told what happened so the UI can say "network busy,
 *   retrying" instead of going quiet.
 *
 * The WebSocket feed is deliberately NOT part of this pool. `wss://testnet-rpc.monad.xyz` is the
 * only endpoint that accepts Monad's `monadNewHeads` / `monadLogs` subscriptions, so it has no
 * alternative and must not be loaded up with transaction traffic.
 */

export type RpcEndpoint = {
  url: string;
  /** Relative share of traffic. Higher means more requests routed here. */
  weight: number;
};

/**
 * Weighted by measured burst tolerance, not by preference. drpc absorbed 60/60 concurrent
 * requests; monad.xyz started rejecting at around 50 per window.
 */
export const DEFAULT_HTTP_ENDPOINTS: RpcEndpoint[] = [
  { url: "https://monad-testnet.drpc.org", weight: 5 },
  { url: "https://testnet-rpc.monad.xyz", weight: 3 },
  { url: "https://rpc.ankr.com/monad_testnet", weight: 2 },
];

/** The only endpoint that serves Monad's speculative `monadNewHeads` / `monadLogs` feeds. */
export const WEBSOCKET_URL = "wss://testnet-rpc.monad.xyz";

export const MONAD_TESTNET_CHAIN_ID = 10143;

export type RpcPoolOptions = {
  endpoints?: RpcEndpoint[];
  maxAttempts?: number;
  /** Base backoff in ms; grows exponentially and is then jittered. */
  baseBackoffMs?: number;
  /** Called whenever a request is throttled or fails, so the UI can show honest state. */
  onRetry?: (info: { attempt: number; url: string; reason: string; waitMs: number }) => void;
};

export class RpcError extends Error {
  readonly attempts: number;
  readonly lastStatus?: number;

  constructor(message: string, attempts: number, lastStatus?: number) {
    super(message);
    this.name = "RpcError";
    this.attempts = attempts;
    this.lastStatus = lastStatus;
  }
}

/** Builds the weighted selection table once, so picking an endpoint is O(1) per request. */
function expand(endpoints: RpcEndpoint[]): string[] {
  const table: string[] = [];
  for (const endpoint of endpoints) {
    for (let i = 0; i < endpoint.weight; i++) table.push(endpoint.url);
  }
  return table;
}

/** Full jitter: pick uniformly in [0, backoff]. Retrying in lockstep just re-triggers the limit. */
function jitter(ms: number): number {
  return Math.floor(Math.random() * ms);
}

export class RpcPool {
  private readonly table: string[];
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly onRetry?: RpcPoolOptions["onRetry"];
  private cursor = Math.floor(Math.random() * 1000);

  /** Counters so the UI and the load test can report real numbers rather than impressions. */
  readonly stats = { requests: 0, retries: 0, throttled: 0, failures: 0 };

  constructor(options: RpcPoolOptions = {}) {
    const endpoints = options.endpoints ?? DEFAULT_HTTP_ENDPOINTS;
    this.table = expand(endpoints);
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 120;
    this.onRetry = options.onRetry;

    if (this.table.length === 0) throw new Error("RpcPool needs at least one endpoint");
  }

  /**
   * Next endpoint, round-robin over the weighted table.
   *
   * The cursor starts at a random offset so that many clients loading the page simultaneously do
   * not all begin on the same endpoint.
   */
  private next(): string {
    return this.table[this.cursor++ % this.table.length];
  }

  /**
   * One JSON-RPC call, retried across endpoints on throttling or transport failure.
   *
   * A JSON-RPC *error response* (the node understood the request and rejected it — a revert, a
   * bad nonce) is NOT retried. Retrying those wastes the shared budget and can double-send.
   */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let lastStatus: number | undefined;
    let lastReason = "unknown";

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const url = this.next();
      this.stats.requests++;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      } catch (error) {
        lastReason = `transport: ${(error as Error).message}`;
        await this.backoff(attempt, url, lastReason);
        continue;
      }

      lastStatus = response.status;

      if (response.status === 429 || response.status === 503) {
        this.stats.throttled++;
        lastReason = `HTTP ${response.status}`;
        await this.backoff(attempt, url, lastReason);
        continue;
      }

      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
        await this.backoff(attempt, url, lastReason);
        continue;
      }

      const json = await response.json();

      if (json.error) {
        // The node answered. Retrying will get the same answer and cost someone else a request.
        throw new RpcError(`${method}: ${json.error.message ?? "rpc error"}`, attempt, response.status);
      }

      return json.result as T;
    }

    this.stats.failures++;
    throw new RpcError(
      `${method} failed after ${this.maxAttempts} attempts (${lastReason})`,
      this.maxAttempts,
      lastStatus,
    );
  }

  private async backoff(attempt: number, url: string, reason: string): Promise<void> {
    this.stats.retries++;
    const waitMs = jitter(this.baseBackoffMs * 2 ** (attempt - 1));
    this.onRetry?.({ attempt, url, reason, waitMs });
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_blockNumber"));
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_gasPrice"));
  }

  async balance(address: string): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [address, "latest"]));
  }

  async transactionCount(address: string, tag: "latest" | "pending" = "pending"): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_getTransactionCount", [address, tag])));
  }

  async sendRawTransaction(signed: string): Promise<string> {
    return this.call<string>("eth_sendRawTransaction", [signed]);
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  /**
   * Round-trip time to a single endpoint, and what that is worth in blocks.
   *
   * Shown to the player rather than hidden. Latency the player cannot see is indistinguishable
   * from randomness, and randomness is what would make elimination feel unfair; latency they can
   * see is information they can act on when choosing between SAFE and DASH. Measured against the
   * pool they actually send through, on whatever wifi they are actually on.
   */
  async measureLatency(samples = 5): Promise<{ p50Ms: number; minMs: number; maxMs: number; blocks: number }> {
    const times: number[] = [];

    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      try {
        await this.blockNumber();
        times.push(performance.now() - started);
      } catch {
        // A failed sample is not a latency sample; excluding it keeps the number honest.
      }
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    if (times.length === 0) return { p50Ms: 0, minMs: 0, maxMs: 0, blocks: 0 };

    times.sort((a, b) => a - b);
    const p50Ms = times[Math.floor(times.length / 2)];

    return {
      p50Ms: Math.round(p50Ms),
      minMs: Math.round(times[0]),
      maxMs: Math.round(times[times.length - 1]),
      blocks: Number((p50Ms / MEASURED_BLOCK_TIME_MS).toFixed(2)),
    };
  }
}

/**
 * Measured block time: 20 blocks in 6,096ms against https://testnet-rpc.monad.xyz, giving
 * 304.8ms/block. Reproduced across separate runs. Used only to express latency in blocks, never
 * to schedule anything — the block number itself comes from the chain.
 */
export const MEASURED_BLOCK_TIME_MS = 304.8;
