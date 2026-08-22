import deployedContracts from "~~/contracts/deployedContracts";
import { MONAD_TESTNET_CHAIN_ID } from "~~/utils/red-light-green-block/rpc";

/**
 * Where the game contract lives, and the slice of its ABI the client actually uses.
 *
 * The ABI is written out here rather than imported wholesale from the generated
 * `deployedContracts` so the player view compiles and runs before anything is deployed. On event
 * day that matters: the frontend has to be buildable and testable while the deploy is still
 * blocked on a human clicking a faucet.
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

export const RED_LIGHT_GREEN_BLOCK_ABI = [
  { type: "function", name: "startRound", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "join", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "step",
    inputs: [{ name: "maxBlock", type: "uint32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getRoundInfo",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint32" },
      { name: "startBlock", type: "uint48" },
      { name: "endBlock", type: "uint48" },
      { name: "active", type: "bool" },
      { name: "winner", type: "address" },
      { name: "playerCount", type: "uint256" },
      { name: "currentBlock", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPlayer",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [
      { name: "joined", type: "bool" },
      { name: "pos", type: "uint16" },
      { name: "eliminated", type: "bool" },
      { name: "lastBlock", type: "uint32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getPlayers",
    inputs: [{ name: "addrs", type: "address[]" }],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        components: [
          { name: "addr", type: "address" },
          { name: "joined", type: "bool" },
          { name: "pos", type: "uint16" },
          { name: "eliminated", type: "bool" },
          { name: "lastBlock", type: "uint32" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRoster",
    inputs: [
      { name: "roundId_", type: "uint32" },
      { name: "start", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
    outputs: [{ name: "page", type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "RoundStarted",
    inputs: [
      { name: "roundId", type: "uint32", indexed: true },
      { name: "startBlock", type: "uint48", indexed: false },
      { name: "endBlock", type: "uint48", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Joined",
    inputs: [
      { name: "roundId", type: "uint32", indexed: true },
      { name: "player", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "Stepped",
    inputs: [
      { name: "roundId", type: "uint32", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "newPos", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Eliminated",
    inputs: [
      { name: "roundId", type: "uint32", indexed: true },
      { name: "player", type: "address", indexed: true },
      { name: "posAtElimination", type: "uint16", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Won",
    inputs: [
      { name: "roundId", type: "uint32", indexed: true },
      { name: "player", type: "address", indexed: true },
    ],
  },
  // Errors, so a revert can be reported as what it means rather than as a hex blob. The one that
  // matters is StepWindowMissed: it is not a failure, it is the player correctly declining a move.
  { type: "error", name: "RoundActive", inputs: [] },
  { type: "error", name: "RoundNotActive", inputs: [] },
  { type: "error", name: "AlreadyJoined", inputs: [] },
  { type: "error", name: "NotJoined", inputs: [] },
  { type: "error", name: "PlayerEliminated", inputs: [] },
  { type: "error", name: "AlreadyActedThisBlock", inputs: [] },
  {
    type: "error",
    name: "StepWindowMissed",
    inputs: [
      { name: "maxBlock", type: "uint32" },
      { name: "currentBlock", type: "uint256" },
    ],
  },
] as const;

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
