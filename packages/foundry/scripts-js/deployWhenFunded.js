#!/usr/bin/env node
/**
 * Waits for the deployer wallet to be funded, then deploys immediately.
 *
 * The faucet at https://faucet.monad.xyz is bot-protected and needs a human, so on event day the
 * gap between "somebody clicks the faucet" and "the contract is live" is dead time we cannot
 * afford. This closes it: leave it running, and the deploy happens the moment the balance lands.
 *
 * Usage: node scripts-js/deployWhenFunded.js
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RPC = process.env.MONAD_RPC ?? "https://testnet-rpc.monad.xyz";
const ARTIFACTS =
  process.env.RLGB_KEY_DIR ??
  join(homedir(), ".copilot/session-state/bb91a248-e63a-4c57-8f58-e62cce563390/files");

const deployer = JSON.parse(readFileSync(join(ARTIFACTS, "deployer.json"), "utf8"))[0];

/** Deploying costs ~1.86M gas; at 102 gwei that is ~0.19 MON. Wait for enough to actually land. */
const MIN_WEI = 200_000_000_000_000_000n; // 0.2 MON

async function balanceWei(address) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return BigInt(json.result);
}

console.log(`Waiting for ${deployer.address} to be funded with >= ${Number(MIN_WEI) / 1e18} MON`);
console.log(`Fund it at https://faucet.monad.xyz`);

let lastReported = -1n;
for (;;) {
  let wei;
  try {
    wei = await balanceWei(deployer.address);
  } catch (error) {
    console.log(`  rpc error, retrying: ${error.message}`);
    await new Promise(r => setTimeout(r, 5000));
    continue;
  }

  if (wei !== lastReported) {
    console.log(`  balance: ${Number(wei) / 1e18} MON`);
    lastReported = wei;
  }

  if (wei >= MIN_WEI) break;
  await new Promise(r => setTimeout(r, 5000));
}

console.log("Funded. Deploying...");

const result = spawnSync(
  "forge",
  [
    "script",
    "script/DeployRedLightGreenBlock.s.sol",
    "--rpc-url",
    RPC,
    "--private-key",
    deployer.private_key,
    "--broadcast",
    "--legacy",
    "--ffi",
  ],
  { cwd: new URL("..", import.meta.url).pathname, stdio: "inherit", env: process.env },
);

if (result.status !== 0) {
  console.error("Deploy failed.");
  process.exit(1);
}

execSync("node scripts-js/generateTsAbis.js", {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "inherit",
});
console.log("Deployed and ABIs regenerated.");
