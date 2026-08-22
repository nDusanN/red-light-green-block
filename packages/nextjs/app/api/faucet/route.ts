import { NextRequest, NextResponse } from "next/server";
import { createWalletClient, custom, formatEther, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { INITIAL_FUNDED_STEPS, targetBurnerBalanceWei, topUpAmountWei } from "~~/utils/red-light-green-block/budget";
import { detectChain } from "~~/utils/red-light-green-block/chain";
import { RpcPool } from "~~/utils/red-light-green-block/rpc";

/**
 * Drips testnet gas into a player's burner wallet.
 *
 * THIS IS NOT A GAME SERVER. There is no game server. This route does exactly one thing — send a
 * small amount of valueless testnet MON so a stranger who scanned a QR code can play without
 * visiting a faucet or installing a wallet. It has no idea who is winning, cannot influence the
 * light, cannot start or stop a round, and cannot eliminate anybody. All of that lives in the
 * contract, where anyone can check it. If this route is down, the game continues for everyone who
 * already has gas.
 *
 * THE HOT WALLET IS THE SCARCE RESOURCE. The official faucet gives 1 MON per wallet per day and
 * there is no larger public source, so the wallet behind this route is a hard budget for the whole
 * event. Two rules follow, and both are enforced below rather than left to good intentions:
 *
 *   1. Top up TO a target, never hand out a flat amount. A player who reloads the page must not be
 *      able to drain the wallet.
 *   2. Refuse when the wallet can no longer fund a whole player, and say so. A wallet that dies
 *      mid-race in front of the room is worse than a clean refusal.
 *
 * NONCE DISCIPLINE, AND WHY IT WAITS. Several people scan the QR at once, so requests arrive
 * concurrently. Two sends that read the nonce at the same time would both use it and one would be
 * dropped. Every send is therefore serialised through a single in-process promise chain, with the
 * nonce tracked locally rather than re-read per request.
 *
 * This route also WAITS for each transaction to be mined before releasing the next one, which is
 * the opposite of what seemed obviously right. Firing them back to back and letting ~305ms blocks
 * absorb them is what a fast chain invites you to do, and on Anvil it worked perfectly: 12
 * concurrent requests, 12 wallets funded, 0.79s.
 *
 * On real Monad testnet it does not work. Measured, four transfers from one funded account:
 *
 *     rapid fire, EIP-1559        2/4 succeeded
 *     rapid fire, legacy gasPrice 1/4 succeeded
 *     400ms spacing               3/4 succeeded
 *     awaiting each receipt       4/4 succeeded
 *
 * The failures are not rejections. They are mined, consume the full 21,000 intrinsic gas, and come
 * back with status 0. viem reports the earlier ones as "Signer had insufficient balance", which is
 * misleading -- the sender held over 3 MON against a 0.0026 MON reservation.
 *
 * The root cause is in the node's handling of several in-flight transactions from one account and
 * is not something this code can see from outside, so it is not guessed at here. What IS measured
 * is that waiting is reliable and not waiting is not. Throughput drops to roughly one wallet per
 * second, which is acceptable: a 50-person room onboards in under a minute, and a player who gets
 * a working wallet slowly is infinitely better than one who gets a silently broken wallet fast.
 */

export const dynamic = "force-dynamic";

const HOT_WALLET_KEY = process.env.FAUCET_PRIVATE_KEY;

/**
 * Keep this much MON back. Below it the route refuses rather than handing out wallets that cannot
 * finish a race. Roughly two players' worth.
 */
const RESERVE_WEI = 90_000_000_000_000_000n; // 0.09 MON

// pinSends is not optional here. This route assigns its own sequential nonces, and endpoints do
// not share a mempool -- spreading a nonce run across hosts makes each one see gaps and hold the
// transactions it cannot place. The symptom appears later and elsewhere, as players whose wallets
// were "funded" reporting insufficient balance.
const pool = new RpcPool({ pinSends: true });

/** Serialises all sends. Every request appends to this chain, so nonces are handed out in order. */
let queue: Promise<unknown> = Promise.resolve();

/** Locally tracked nonce, refreshed from the chain only when we have not sent anything yet. */
let nextNonce: number | undefined;

/** Cumulative drip total, logged so the burn rate is visible live and we can see when we run dry. */
let totalDrippedWei = 0n;
let dripCount = 0;

/** Per-address cooldown, a second line of defence behind the balance check. */
const lastDripAt = new Map<string, number>();
const COOLDOWN_MS = 15_000;

/**
 * Polls for a receipt and reports whether the transaction actually succeeded.
 *
 * Checks `status`, not merely presence: on Monad these failures come back as MINED receipts with
 * status 0, so treating "a receipt exists" as success would report a funded wallet that has no
 * funds -- the exact failure this whole waiting scheme exists to prevent.
 */
async function waitForInclusion(hash: string, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      const receipt = await pool.call<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
      if (receipt) return receipt.status === "0x1";
    } catch {
      // Transient read failure; keep polling until the deadline.
    }
  }
  return false;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  // Keep the chain alive even if a task rejects, or one failure would wedge the faucet for good.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function POST(request: NextRequest) {
  if (!HOT_WALLET_KEY) {
    return NextResponse.json(
      { error: "Faucet is not configured. Set FAUCET_PRIVATE_KEY and restart." },
      { status: 503 },
    );
  }

  let address: string;
  try {
    ({ address } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "A valid address is required" }, { status: 400 });
  }

  const now = Date.now();
  const last = lastDripAt.get(address.toLowerCase());
  if (last && now - last < COOLDOWN_MS) {
    return NextResponse.json({ skipped: true, reason: "Recently funded. Give it a few seconds." }, { status: 200 });
  }

  try {
    const account = privateKeyToAccount(HOT_WALLET_KEY as `0x${string}`);

    // A live gas price, so the drip self-corrects if the base fee moves rather than silently
    // under-funding every wallet from then on.
    let gasPriceWei: bigint;
    try {
      gasPriceWei = await pool.gasPrice();
    } catch {
      gasPriceWei = 102_000_000_000n; // the value measured on testnet, used only if the read fails
    }

    const targetWei = targetBurnerBalanceWei({ gasPriceWei, steps: INITIAL_FUNDED_STEPS });
    const [playerBalance, hotBalance] = await Promise.all([pool.balance(address), pool.balance(account.address)]);

    const amountWei = topUpAmountWei({ currentBalanceWei: playerBalance, targetWei });

    if (amountWei === 0n) {
      return NextResponse.json({
        skipped: true,
        reason: "Wallet already has enough gas to play.",
        balanceWei: playerBalance.toString(),
      });
    }

    // Refuse rather than hand out a wallet that cannot finish. Stated plainly so the UI can tell
    // the player to find an organiser instead of leaving them at a dead button.
    if (hotBalance < amountWei + RESERVE_WEI) {
      console.warn(
        `[faucet] REFUSED: hot wallet ${formatEther(hotBalance)} MON is below the reserve. ` +
          `Dripped ${formatEther(totalDrippedWei)} MON across ${dripCount} wallets so far.`,
      );
      return NextResponse.json(
        {
          error: "The faucet is out of testnet MON. Please ask an organiser to top it up.",
          hotWalletMon: formatEther(hotBalance),
        },
        { status: 503 },
      );
    }

    const hash = await enqueue(async () => {
      if (nextNonce === undefined) {
        nextNonce = await pool.transactionCount(account.address, "pending");
      }
      const nonce = nextNonce;
      nextNonce = nonce + 1;

      const client = createWalletClient({
        account,
        chain: await detectChain(pool),
        transport: custom({
          request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]),
        }),
      });

      try {
        // A plain value transfer to an EOA: exactly 21,000 gas, no estimate needed.
        const hash = await client.sendTransaction({
          to: address as `0x${string}`,
          value: amountWei,
          gas: 21_000n,
          nonce,
        });

        // Wait for inclusion before releasing the queue. See the note above: not waiting silently
        // loses most of the sends on real Monad testnet.
        const minedOk = await waitForInclusion(hash);
        if (!minedOk) {
          nextNonce = undefined;
          throw new Error("Funding transaction did not succeed; please try again");
        }

        return hash;
      } catch (error) {
        // Resynchronise on the next request rather than leaving a permanently wrong local nonce.
        nextNonce = undefined;
        throw error;
      }
    });

    lastDripAt.set(address.toLowerCase(), now);
    totalDrippedWei += amountWei;
    dripCount++;

    const remaining = hotBalance - amountWei;
    console.log(
      `[faucet] sent ${formatEther(amountWei)} MON to ${address} (${hash}). ` +
        `Total ${formatEther(totalDrippedWei)} MON across ${dripCount} wallets. ` +
        `Hot wallet ~${formatEther(remaining)} MON, about ${remaining / targetWei} more players.`,
    );

    return NextResponse.json({
      hash,
      amountWei: amountWei.toString(),
      amountMon: formatEther(amountWei),
      fundedSteps: INITIAL_FUNDED_STEPS,
      hotWalletMon: formatEther(remaining),
      playersRemaining: Number(remaining / targetWei),
    });
  } catch (error) {
    console.error("[faucet] failed:", error);
    return NextResponse.json({ error: (error as Error).message ?? "Faucet failed" }, { status: 500 });
  }
}

/** Status endpoint, so an organiser can check the budget without reading server logs. */
export async function GET() {
  if (!HOT_WALLET_KEY) {
    return NextResponse.json({ configured: false, error: "FAUCET_PRIVATE_KEY is not set" }, { status: 503 });
  }

  try {
    const account = privateKeyToAccount(HOT_WALLET_KEY as `0x${string}`);
    const [hotBalance, gasPriceWei] = await Promise.all([pool.balance(account.address), pool.gasPrice()]);
    const targetWei = targetBurnerBalanceWei({ gasPriceWei, steps: INITIAL_FUNDED_STEPS });

    return NextResponse.json({
      configured: true,
      address: account.address,
      hotWalletMon: formatEther(hotBalance),
      dripMon: formatEther(targetWei),
      playersRemaining: Number(hotBalance > RESERVE_WEI ? (hotBalance - RESERVE_WEI) / targetWei : 0n),
      totalDrippedMon: formatEther(totalDrippedWei),
      walletsFunded: dripCount,
      gasPriceGwei: Number(gasPriceWei / 1_000_000_000n),
    });
  } catch (error) {
    return NextResponse.json({ configured: true, error: (error as Error).message }, { status: 500 });
  }
}
