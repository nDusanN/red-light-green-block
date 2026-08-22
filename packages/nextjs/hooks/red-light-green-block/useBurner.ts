"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Account, createWalletClient, custom, encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { RED_LIGHT_GREEN_BLOCK_ABI } from "~~/utils/red-light-green-block/contract";
import { RpcPool } from "~~/utils/red-light-green-block/rpc";

/**
 * A throwaway wallet generated in the browser and kept in localStorage.
 *
 * ONBOARDING IS THE WHOLE GAME. A voter has to be able to scan a QR code and be playing within
 * about twenty seconds. Anything that shows a wallet-connect modal, asks for a seed phrase, or
 * pops a signature prompt per move loses most of the room before the first step. So: a key is
 * generated on first load, funded automatically by `/api/faucet`, and every transaction is signed
 * locally with no prompt.
 *
 * This is obviously not how you would handle a key that mattered. It is a testnet key holding
 * about 0.045 MON of valueless gas, generated for one afternoon, stored in localStorage in the
 * clear. Do not reuse this pattern for anything with real value.
 */

const STORAGE_KEY = "rlgb.burner.privateKey.v1";

function loadOrCreateKey(): `0x${string}` {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) return existing as `0x${string}`;

  const created = generatePrivateKey();
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}

export function useBurner(pool: RpcPool) {
  const [account, setAccount] = useState<Account>();
  const [balanceWei, setBalanceWei] = useState<bigint>();
  const [funding, setFunding] = useState(false);
  const [fundingError, setFundingError] = useState<string>();
  const fundingAttempted = useRef(false);

  // Created in an effect, not during render: localStorage does not exist on the server, and a key
  // generated during render would differ between the server and client passes.
  useEffect(() => {
    setAccount(privateKeyToAccount(loadOrCreateKey()));
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!account) return undefined;
    try {
      const wei = await pool.balance(account.address);
      setBalanceWei(wei);
      return wei;
    } catch {
      // A transient balance-read failure is not worth surfacing; it retries on the next tick.
      return undefined;
    }
  }, [account, pool]);

  /** Ask the server faucet to top this wallet up. Reports refusals honestly. */
  const requestFunding = useCallback(async () => {
    if (!account) return;
    setFunding(true);
    setFundingError(undefined);

    try {
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: account.address }),
      });
      const body = await response.json();

      if (!response.ok) {
        setFundingError(body?.error ?? `faucet returned HTTP ${response.status}`);
      } else if (!body.skipped) {
        // The faucet does not wait for a receipt before replying, so poll our own balance until
        // the drip lands. At ~300ms blocks this is normally one or two ticks.
        for (let i = 0; i < 12; i++) {
          await new Promise(resolve => setTimeout(resolve, 400));
          const wei = await refreshBalance();
          if (wei && wei > 0n) break;
        }
      } else {
        await refreshBalance();
      }
    } catch (error) {
      setFundingError((error as Error).message);
    } finally {
      setFunding(false);
    }
  }, [account, refreshBalance]);

  // Fund once, automatically, as soon as we know the wallet is empty.
  useEffect(() => {
    if (!account || fundingAttempted.current) return;

    (async () => {
      const wei = await refreshBalance();
      if (wei !== undefined && wei === 0n) {
        fundingAttempted.current = true;
        await requestFunding();
      }
    })();
  }, [account, refreshBalance, requestFunding]);

  // Keep the balance roughly current so the UI can warn before the wallet runs dry. Deliberately
  // slow: a background nicety must not compete with steps for the shared rate-limit budget.
  useEffect(() => {
    if (!account) return;
    const timer = setInterval(refreshBalance, 8000);
    return () => clearInterval(timer);
  }, [account, refreshBalance]);

  /**
   * Signs and sends a contract call through the resilient pool.
   *
   * The gas limit is supplied by the caller because it is a game decision, not a transport one:
   * the client declares a tight measured limit and raises it near the finish. Nothing here calls
   * `eth_estimateGas`, which carries the tightest rate limit of any RPC method and is exactly what
   * has to be conserved.
   */
  const send = useCallback(
    async (args: {
      to: `0x${string}`;
      functionName: "join" | "step" | "startRound";
      args?: readonly unknown[];
      gas: bigint;
    }): Promise<`0x${string}`> => {
      if (!account) throw new Error("wallet not ready");

      const client = createWalletClient({
        account,
        chain: monadTestnet,
        transport: custom({
          request: ({ method, params }) => pool.call(method, (params ?? []) as unknown[]),
        }),
      });

      const data = encodeFunctionData({
        abi: RED_LIGHT_GREEN_BLOCK_ABI,
        functionName: args.functionName,
        args: args.args as never,
      });

      return client.sendTransaction({ to: args.to, data, gas: args.gas });
    },
    [account, pool],
  );

  return {
    account,
    address: account?.address,
    balanceWei,
    funding,
    fundingError,
    ready: Boolean(account),
    refreshBalance,
    requestFunding,
    send,
  };
}
