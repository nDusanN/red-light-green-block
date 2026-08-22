/**
 * The slice of the game contract's ABI the client uses.
 *
 * Deliberately its own module with ZERO imports. It is loaded both by the Next.js app and by the
 * headless playtest running under plain Node, and the generated `deployedContracts.ts` uses the
 * `~~` path alias that only Next.js understands. Keeping the ABI free of dependencies means the
 * playtest can drive the real client stack without dragging the whole app's module graph with it.
 *
 * Written out by hand rather than imported from the generated file so the frontend also compiles
 * and runs before anything is deployed -- which matters on event day, when the deploy is blocked
 * on a human clicking a faucet.
 */

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
