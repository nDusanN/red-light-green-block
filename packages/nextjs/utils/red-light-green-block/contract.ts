import { MONAD_TESTNET_CHAIN_ID } from "./rpc.ts";
import deployedContracts from "~~/contracts/deployedContracts";

export { RED_LIGHT_GREEN_BLOCK_ABI } from "./abi.ts";

/**
 * Where the game contract lives.
 *
 * The ABI itself lives in `abi.ts`, which has no imports, so it can be loaded by tooling that does
 * not understand the Next.js `~~` path alias. It is re-exported here for convenience.
 */

/** Set `NEXT_PUBLIC_RLGB_ADDRESS` to point a build at a specific deployment. */
const ENV_ADDRESS = process.env.NEXT_PUBLIC_RLGB_ADDRESS;

type DeployedMap = Record<number, Record<string, { address: string }>>;

function fromGenerated(chainId: number): string | undefined {
  const byChain = deployedContracts as unknown as DeployedMap;
  return byChain?.[chainId]?.RedLightGreenBlock?.address;
}

/**
 * The deployed address, or `undefined` if there isn't one yet.
 *
 * Deliberately returns `undefined` rather than throwing or falling back to the zero address. A
 * zero address would produce confusing "transaction reverted" noise; `undefined` lets the UI say
 * plainly that no deployment is configured.
 */
export function gameAddress(chainId: number = MONAD_TESTNET_CHAIN_ID): `0x${string}` | undefined {
  const address = ENV_ADDRESS ?? fromGenerated(chainId);
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  return address as `0x${string}`;
}

export type RoundInfo = {
  roundId: number;
  startBlock: bigint;
  endBlock: bigint;
  active: boolean;
  winner: `0x${string}`;
  playerCount: number;
  currentBlock: bigint;
};

export type PlayerState = {
  joined: boolean;
  pos: number;
  eliminated: boolean;
  lastBlock: number;
};
