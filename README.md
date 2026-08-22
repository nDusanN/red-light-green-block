# Red Light, Green Block

An on-chain reflex race for a room full of phones, built on Monad.

| | |
|---|---|
| **Play** | *URL published at the event* &nbsp;·&nbsp; `/play` |
| **Contract** | **not yet deployed** — see [Deploying](#deploying) |
| **Network** | Monad Testnet, chain id **10143** |

A room races along a 20-step track. Tap STEP and you send a real transaction. If it lands in a
**green** block you advance one step. If it lands in a **red** block you are eliminated, for good.
One step per block per player, so the winner is decided by nerve, not by how fast you can tap.
First to step 20 wins.

**The traffic light is a pure function of the block number.** There is no server, no admin key, no
oracle and no off-chain clock. `lightAt(roundId, roundStartBlock, blockNumber)` is `pure`: anyone
can compute the entire schedule of a round, for every block, forwards and backwards, offline. The
chain is the referee, and the referee's rulebook is public.

That is the whole design claim, and it is checkable in about thirty seconds of reading the contract.

---

## Why this only works on Monad

On a 12-second chain this game is unplayable. You would tap, wait twelve seconds, and find out.

At **304.8ms per block** (measured, below) the light changes every few seconds and a step resolves
before you have lifted your thumb. The interesting decision becomes: *the light turns red in two
blocks and my transaction needs about one block to land — do I go?*

That question only exists at 300ms. It is the game.

---

## Deployed

Explorer: https://testnet.monadvision.com

> Deployment was blocked on funding: `faucet.monad.xyz` is bot-protected and returns HTTP 429 to
> scripted requests, so a human has to claim. `packages/foundry/scripts-js/deployWhenFunded.js`
> polls the deployer address and deploys the instant it is funded.

### Prior art

[SquidChain](https://squidchain.io) (Aurora / NEAR EVM) runs a similar red-light-green-light
premise on-chain. It differs in the ways that matter here: it uses a backend server to drive
rounds, features AI agents as players, and resolves elimination on *last to transact* rather than
on block parity. Red Light, Green Block has no server at all, and elimination is decided purely by
which block your transaction lands in — a rule anyone can evaluate offline for any block, past or
future.

---

## The design decisions that matter

### 1. The light is computed on the client, never fetched

Rate limits on the public Monad RPC are **per IP**, and at a venue the whole room is behind one NAT.
The room does not get fifty players' worth of budget — it gets one IP's worth, shared. Every read a
phone makes is a transaction some other phone cannot send.

So the light is never read from the chain. A client fetches the round anchor **once** via
`getRoundInfo()` and computes every block's colour locally from then on. Rendering the light costs
zero RPC calls, at any frame rate, forever.

That makes the TypeScript port correctness-critical: if it disagreed with Solidity by one block,
players would see green, step, and be killed by a chain that saw red. The game would look broken and
rigged at the same time.

So it is not trusted on inspection. A fixture is generated from the Solidity implementation and
**two independent tests check against it** — `LightFixtureParity.t.sol` in Foundry and
`light.test.ts` in Node. Solidity == fixture and TypeScript == fixture, therefore Solidity ==
TypeScript, with neither implementation ever importing the other. Neither test regenerates the
fixture, because a test that regenerates its own reference lets both sides drift while staying
green.

It already earned its keep: it caught `TRACK_LENGTH` still being 100 on the TypeScript side seconds
after the contract changed to 20.

### 2. `step()` writes exactly one storage slot

```solidity
struct Player { uint16 pos; uint32 roundId; uint32 lastBlock; bool eliminated; }
mapping(address => Player) public players;
```

88 bits, so a player's entire state is one slot and one `SSTORE`. There is deliberately **no global
step counter, no total-moves aggregate and no leaderboard array** updated on every move. Any such
slot would be written by every transaction in the game, making every pair of transactions conflict
under optimistic parallel execution. Aggregates come from events instead.

**What this does not claim.** The contract cannot and does not assert that any two transactions were
literally executed concurrently by a Monad node. That is a property of the node's scheduler, it is
not observable from inside the EVM, and asserting it would be dressing up a hope as a result. The
narrower, checkable claim is the one made here: *the storage layout does not force serialisation
between two different players' steps.*

For completeness, `step()` *reads* two shared slots — the packed round slot and `roundWinner`. The
first is written only by `startRound()`, the second at most once per round by the winning step. So a
step can only conflict with those two transactions, never with another player's step.

The one genuine contention point is `join()`, which appends to a per-round roster array and so
writes a shared length slot. It is bounded at once per player per round, and it buys the stage view
the ability to enumerate the field in a single `eth_call` rather than depending on historical log
queries — the least reliable thing to lean on at a live event. It could be removed by deriving the
roster from `Joined` events, leaving the contract with **no** shared write at all. That is a real
improvement, deliberately not taken here, because a deployed game beats an elegant undeployed one.

### 3. `step(maxBlock)` makes inclusion risk a choice, not a lottery

This is the fairness fix, and the part most worth stealing.

A bare `step()` eliminates you whenever it happens to execute in a red block. But under load a
transaction can slip a block, so a player who timed their move correctly could still die through no
fault of their own. Elimination would be partly a mempool lottery, and "how is that fair?" is a
question that loses a peer vote.

Instead the player declares a deadline:

```solidity
function step(uint32 maxBlock) external
```

> execute this at any block up to `maxBlock`, and if you cannot, do nothing at all.

Past that block the call **reverts harmlessly** — no advance, no elimination, the turn is simply
lost. The two buttons are just two deadlines:

- **SAFE STEP** → `maxBlock = block + 1`. One possible landing block, whose colour you can already
  see. Often a guaranteed advance.
- **DASH** → `maxBlock = block + 4`. Far more likely to land at all, but it may land after the light
  turns.

The risk is now entirely attributable to the player's own decision, and the wager is the most
Monad-native one available: you are betting on block inclusion timing.

Declining is deliberately cheap — the missed-window path costs **1,710 gas** of execution against
21,000 intrinsic. Caution should not feel like a punishment.

### 4. A red step must not revert

Landing on red *eliminates* you, and elimination is a state change. Reverting would roll it back and
the punishment would silently never happen. So `step()` returns normally on red and records it.

The consequence for clients is important and easy to get wrong: **a successful transaction is not a
successful step.** The client must re-read state or read the event, never assume.

### 5. The gas limit is measured, not guessed

Monad charges for the gas limit a transaction **declares**, not the gas it uses. The 1.5x buffer most
wallets apply by default is not free here — it is gas the player pays for and never consumes.

Every limit is a measured worst case plus 7.5%, the margin
[Category Labs](https://www.category.xyz/blogs/setting-your-gas-limit-on-monad) found minimises
failure rate on Monad, applied to a measured figure rather than an `eth_estimateGas` result. Nothing
in the client calls `eth_estimateGas` at all: it carries the tightest rate limit of any RPC method
and is exactly what has to be conserved.

Two measurement mistakes were found this way, both of which would have failed real transactions:

- **The winning step costs 2.2x an ordinary one** (39,268 vs 17,544) because it also writes
  `roundWinner` from zero. Sizing every step off the typical figure would have failed exactly one
  transaction per round: the one that wins it. The client raises its limit for the last two steps.
- **`join` measured with a reused address gave 41,420 gas**, because overwriting a non-zero player
  slot costs 5,000 rather than 20,000. A genuinely new address costs **75,620**. Declaring the
  cheaper figure would have failed every new player at the moment they tried to get in.

---

## Measured numbers

Everything here came from a run. Nothing is an estimate, and anything that is an assumption says so.

### Network — probed directly against `https://testnet-rpc.monad.xyz`

|  |  |
|---|---|
| Chain id | `0x279f` = 10143 |
| Block time | **304.8 ms** (20 blocks in 6,096 ms, reproduced) |
| `eth_blockNumber` RTT, 15 samples | min 27 / **p50 29** / p90 32 / max 100 ms |
| Gas price | 102 gwei |

p50 latency is **0.10 blocks**, so the player's decision — not their network — dominates the
outcome. The client measures each player's own RTT and shows it in blocks, because latency a player
cannot see is indistinguishable from randomness, while latency they can see is information.

### Burst tolerance — 60 concurrent requests per endpoint

| Endpoint | Result |
|---|---|
| `https://monad-testnet.drpc.org` | **60 ok / 0 rejected** |
| `https://testnet-rpc.monad.xyz` | 45 ok / **15 x HTTP 429** |
| `https://rpc.ankr.com/monad_testnet` | 30 ok / 30 x HTTP 429 |
| `https://rpc-testnet.monadinfra.com` | 20 ok / **40 x HTTP 429** |

The client round-robins across a pool weighted by exactly this, picking per *request* rather than per
session so simultaneous page loads do not converge on one host. A 429 is retried on a different
endpoint with exponential backoff **plus full jitter** — without jitter, everyone throttled by the
same block retries in lockstep and throttles again together.

`wss://testnet-rpc.monad.xyz` is the **only** endpoint accepting Monad's `monadNewHeads` and
`monadLogs` subscriptions (drpc rejects them on the free plan; monadinfra refuses the connection), so
it is kept out of the transaction pool entirely.

### Gas — `forge test`, cold storage via `vm.cool`, execution only

`vm.cool` matters: Foundry runs a whole test as one transaction, so without it every figure would be
a warm-slot cost that no real standalone transaction enjoys.

| Path | Execution gas | Declared limit |
|---|---|---|
| `step`, green advance | 17,544 | 42,054 |
| `step`, red elimination | 17,284 | 42,054 |
| `step`, missed window | **1,710** | — |
| `step`, **winning** | 39,268 | 65,407 |
| `join`, new address, first of round | 75,620 | 103,935 |
| `startRound` | 49,789 | 76,166 |
| Contract deployment | 1,858,560 | — |

Declared limits include the 21,000 intrinsic cost and calldata. A default wallet's 1.5x-on-estimate
would declare 58,680 for an ordinary step against our 42,054 — **24.2% cheaper** across a whole game.

### The light schedule — 20,000 blocks, measured in both implementations

|  |  |
|---|---|
| Green share | **52.3%** |
| Green run length | min 12 / max 30 blocks |
| In seconds | 3.7s to 9.1s of green at a time |

### End-to-end playtest — 5 bots, local Anvil at 1s blocks

|  |  |
|---|---|
| Joins | 5 (0 failed) |
| Steps sent / landed green | 25 / 20 |
| Eliminated on red | 5 |
| Send errors / throttled | 0 / 0 |
| Inclusion latency | p50 960ms, p90 1060ms (~1 block) |

> The first version of this run reported p50 4021ms. That was viem's default 4000ms
> `pollingInterval`, not the chain — a measurement of the polling loop dressed up as a measurement of
> Monad. It is 100ms now. Recorded because it is exactly the kind of number that ends up on a slide.

**Not yet measured:** a 50-bot run against the public testnet RPC. The 429 rate under real room load
is the open question, and it is stated as open rather than assumed fine.

---

## The budget, and why the track is 20 steps

The binding constraint on this project is not Monad and not the contract. **It is the faucet.**

`faucet.monad.xyz` gives 1 MON per wallet per day and there is no larger public source. Monad charges
on the declared gas limit, and testnet base fee is 100 gwei. So:

| Players | Worst case | Expected | Faucet wallet-days (worst) |
|---|---|---|---|
| 10 | 0.99 MON | 0.61 MON | 1 |
| 25 | 2.47 MON | 1.52 MON | 3 |
| 50 | **4.94 MON** | **3.03 MON** | 5 |
| 100 | 9.88 MON | 6.06 MON | 10 |

*Worst case* assumes every player joins and runs the full track. *Expected* assumes half the track and
a 25% declined-step rate — those two are **modelling assumptions, not measurements**, and the
worst-case column deliberately does not depend on them.

The track was originally 100 steps. At that length, 50 players cost **22.1 MON** — about 23 days of
faucet farming to run one demo. Not fundable. Cutting to 20 made it affordable *and* made it a better
game: a 20-step race is 25-40 seconds, short enough to run repeatedly in front of an audience and
short enough for someone to walk up and play a whole round.

The faucet route tops burners up **to** a target of ~0.045 MON (one join plus eight steps) rather than
handing out a flat amount. Most players are eliminated in the first one or two red phases, so
provisioning everyone for a full track drains the wallet on people who never needed it. This gets
**22 players per MON instead of 8.** Survivors who exhaust it are topped up on demand.

**The two real constraints here are the free RPC tier and the faucet. Both are operational limits, not
Monad limits.** The chain itself was never the bottleneck at any point in this build.

---

## Onboarding: no wallet, no signatures

A voter has to be playing within about twenty seconds of scanning a QR code. So:

- A burner key is generated in the browser on first load and kept in `localStorage`.
- `/api/faucet` drips gas automatically. No faucet visit, no MetaMask, no signature prompt per move.

**`/api/faucet` is not a game server. There is no game server.** It sends gas and nothing else. It
cannot influence the light, start or stop a round, or eliminate anybody — all of that is in the
contract where anyone can check it. If the faucet is down, the game continues for everyone who
already has gas.

It refuses to drip below a reserve and says so plainly, because a wallet that dies mid-race in front
of the room is worse than a clean refusal. All sends are serialised through a single nonce queue —
concurrent QR scans would otherwise reuse a nonce and silently drop sends — and receipts are
deliberately not awaited between sends, since at 305ms blocks that would serialise onboarding to one
player per block.

> The burner key is a testnet key holding ~0.045 MON of valueless gas, stored in `localStorage` in the
> clear. Do not reuse this pattern for anything with real value.

---

## Running it

```bash
yarn install
yarn foundry:test          # 47 Solidity tests
yarn next:test             # 28 TypeScript tests, including Solidity parity
yarn start                 # http://localhost:3000/play
```

### Deploying

```bash
# Fund the deployer at https://faucet.monad.xyz, then:
cd packages/foundry
node scripts-js/deployWhenFunded.js     # polls, deploys the moment funds land
```

Then set `FAUCET_PRIVATE_KEY` (a wallet with a few MON) so `/api/faucet` can drip, and point the
frontend at the deployment with `NEXT_PUBLIC_RLGB_ADDRESS` if it is not picked up automatically.

**Before a real event, get a paid Alchemy or QuickNode key.** The free-tier endpoint split above is a
workable fallback, but a paid key is the actual fix for the per-IP rate limit.

### Load / sanity check

```bash
cd packages/nextjs
node --experimental-strip-types scripts/playtest.ts \
  --rpc https://testnet-rpc.monad.xyz --address 0xYOURCONTRACT \
  --funder 0xFUNDEDKEY --bots 5
```

### Regenerating the light parity fixture

Only after a deliberate change to the schedule:

```bash
yarn foundry:light-fixture
yarn next:test              # confirm TypeScript still agrees
```

---

## Layout

| Path |  |
|---|---|
| `packages/foundry/contracts/RedLightGreenBlock.sol` | The whole game |
| `packages/foundry/test/RedLightGreenBlock.t.sol` | 42 behavioural tests |
| `packages/foundry/test/LightFixtureParity.t.sol` | Solidity vs the fixture |
| `packages/nextjs/utils/red-light-green-block/light.ts` | TypeScript port of the light |
| `packages/nextjs/utils/red-light-green-block/light.test.ts` | TypeScript vs the same fixture |
| `packages/nextjs/utils/red-light-green-block/gas.ts` | Measured gas limits |
| `packages/nextjs/utils/red-light-green-block/budget.ts` | Funding model |
| `packages/nextjs/utils/red-light-green-block/rpc.ts` | Weighted endpoint pool |
| `packages/nextjs/app/play/page.tsx` | Player view |
| `packages/nextjs/app/api/faucet/route.ts` | Gas drip |
| `packages/nextjs/scripts/playtest.ts` | Headless multi-wallet playtest |

Unaudited testnet demo code. No admin key, no upgradeability, no value at risk.
