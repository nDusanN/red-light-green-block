// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title RedLightGreenBlock
 * @author Monad Blitz Hackathon
 * @notice An on-chain "Red Light, Green Light" race. A whole room of players races along a
 *         100-step track. The traffic light is a pure function of the block number, so the chain
 *         itself is the referee: there is no server, no oracle, no admin key and no off-chain
 *         clock of any kind.
 *
 * @dev DESIGN NOTES — read these before changing anything.
 *
 *      1. THE LIGHT IS A PURE FUNCTION OF THE BLOCK NUMBER.
 *         `lightAt(roundId, roundStartBlock, blockNumber)` is `pure`. Every input a client needs
 *         is fetched once, when it joins, and never again — so a client can render the light for
 *         any past or future block with ZERO RPC calls. This is not a stylistic choice. The
 *         public Monad testnet RPC rate-limits requests per IP, and at a live event a whole room
 *         is behind one NAT. Every read a phone makes is a transaction some other phone cannot
 *         send. Keeping the light client-computable is what leaves the rate-limit budget free for
 *         `eth_sendRawTransaction`.
 *
 *         The schedule is deliberately PRECOMPUTABLE, NOT UNPREDICTABLE. It hashes only public,
 *         deterministic inputs, so anyone can derive the entire round in advance. It is the
 *         opposite of a VRF and must never be used as one. The game's skill is in reading a
 *         schedule you can already see and judging whether your transaction lands before the
 *         light turns — not in guessing a secret.
 *
 *      2. `step()` WRITES EXACTLY ONE STORAGE SLOT: `players[msg.sender]`.
 *         There is deliberately no global step counter, no "total moves" aggregate and no
 *         leaderboard array touched on every move. Any such slot would be written by every single
 *         transaction in the game, which would make every pair of transactions conflict under
 *         optimistic parallel execution. All aggregates are derived from events off-chain
 *         instead.
 *
 *         This contract does NOT claim that any particular pair of transactions was literally
 *         executed concurrently by a Monad node. That is a property of the node's scheduler and
 *         is not observable from inside the EVM, so it is not something this code can honestly
 *         assert. The guarantee made here is narrower and actually checkable: the storage layout
 *         does not *force* serialisation between two different players' `step()` calls.
 *
 *         For completeness, `step()` READS two shared slots — the packed `round` slot and
 *         `roundWinner`. `round` is written only by `startRound()`, and `roundWinner` at most
 *         once per round by the winning step. So a `step()` can only conflict with those two
 *         transactions, never with another player's step.
 *
 *      3. `join()` IS THE ONE CONTENDED WRITE, AND IT IS DELIBERATE.
 *         `join()` appends the player to a per-round roster array, so every join writes the same
 *         array-length slot and simultaneous joins DO conflict with each other. This is an
 *         accepted trade-off, bounded at once per player per round: it lets a freshly loaded
 *         stage view enumerate the whole field with a single `eth_call` instead of depending on
 *         historical log queries, which are the least reliable thing to lean on at a live event.
 *         `Joined` events are emitted too, so a log-only client is also possible. The worst case
 *         is the start of a round, when the entire room joins at once; see the README for what
 *         that actually measured.
 *
 *      4. A RED STEP MUST NOT REVERT.
 *         Landing in a red block eliminates the player, and elimination is a STATE CHANGE.
 *         Reverting would roll it back, and the punishment would silently never happen. So
 *         `step()` returns normally on red and records the elimination. Reverts are reserved for
 *         calls that should never have been sent at all. A client therefore CANNOT treat a
 *         successful transaction as a successful step; it must read the emitted event.
 *
 *      5. `maxBlock` MAKES INCLUSION RISK A PLAYER'S CHOICE, NOT A LOTTERY.
 *         A bare `step()` would eliminate you whenever it happened to execute in a red block. But
 *         under load a transaction can slip a block, so a player who timed their move correctly
 *         could still die through no fault of their own — elimination would be partly a mempool
 *         lottery, and the game would not be defensibly fair.
 *
 *         Instead the player declares a deadline: "execute this at any block up to `maxBlock`,
 *         and if you cannot, do nothing at all." Past that block the call reverts harmlessly and
 *         the player merely loses a turn. A tight deadline wastes turns; a greedy deadline
 *         reaching past the green boundary risks landing in red. Either way the risk is
 *         attributable entirely to the player's own decision. It also makes the wager an
 *         explicitly Monad-native one: you are betting on block inclusion timing.
 *
 *      6. THE COST OF A MOVE IS PART OF THE DESIGN.
 *         Monad charges for the DECLARED gas limit, not for gas used, so a wallet's habitual 1.5x
 *         buffer is not free here — it is gas the player pays for and never consumes. Every
 *         function in this contract is therefore kept to a predictable, measurable cost, events
 *         carry no redundant fields, and `step()` writes one slot.
 *
 *         The client declares a tight limit derived from a measured worst case rather than an
 *         estimate multiplied by a round number; see `MEASURED_STEP_GAS` in
 *         `packages/nextjs/utils/red-light-green-block/gas.ts`. The worst case is the winning
 *         step, which additionally writes `roundWinner` from zero and so costs materially more
 *         than an ordinary step. Sizing the limit off a typical step would make exactly one
 *         transaction per round fail: the one that wins it.
 *
 *      No admin key, no owner, no upgradeability, no token/NFT/DeFi logic and no value transfers.
 *      `startRound()` is permissionless so the game can never stall waiting on an operator.
 *      This is unaudited testnet demo code.
 */
contract RedLightGreenBlock {
    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Steps required to win. A player wins on the step that takes `pos` to this value.
     *
     * @dev 20, not 100, and the reason is economic as much as it is about pacing.
     *
     *      Monad charges for the DECLARED gas limit rather than gas used, and testnet base fee sat
     *      at 100 gwei when this was measured (`eth_gasPrice` returned 102 gwei). Every step is a
     *      real transaction, so a race is `players x steps` transactions and the cost scales with
     *      the track length directly. At 100 steps, 50 players finishing would cost on the order
     *      of 30 MON — and the official faucet dispenses 1 MON per wallet per day, with no larger
     *      public source. A 100-step track is therefore not fundable for a demo; it would need
     *      roughly a month of faucet collection to run once.
     *
     *      20 is also the better game. One step per block means 20 steps needs at least 20 green
     *      blocks, and with the measured 52.3% green share a real race runs about 25-40 seconds.
     *      That is short enough to run repeatedly in front of an audience and short enough for
     *      somebody to walk up and play a whole round.
     */
    uint16 public constant TRACK_LENGTH = 20;

    /// @notice Length of one full green-then-red cycle, in blocks. At Monad's measured 300ms
    ///         cadence this is 12 seconds. A game-design constant, not a protocol parameter.
    uint256 public constant CYCLE_LENGTH_BLOCKS = 40;

    /// @notice Fewest blocks at the start of a cycle that are green (12 blocks = 3.6s at 300ms).
    uint256 public constant MIN_GREEN_BLOCKS = 12;

    /// @notice Most blocks at the start of a cycle that are green (30 blocks = 9.0s at 300ms).
    /// @dev Must stay strictly below CYCLE_LENGTH_BLOCKS so every cycle contains at least one red
    ///      block; otherwise a cycle could be entirely green and there would be no risk in it.
    uint256 public constant MAX_GREEN_BLOCKS = 30;

    /**
     * @notice How long a round lasts, in blocks. 300 blocks = 91 seconds at the measured
     *         304.8ms/block. A round also ends the instant somebody wins.
     *
     * @dev This is a backstop, not the expected length. A 20-step race is normally decided in
     *      roughly 25-40 seconds, and a win ends the round immediately, so the deadline only binds
     *      when the entire field is eliminated without a winner. In that case the room waits out
     *      the remainder before anyone can call `startRound()` again.
     *
     *      Shortening it would make that dead time briefer but would also cut off a genuinely slow,
     *      cautious finish. 300 was chosen as roughly three times a typical winning race.
     */
    uint256 public constant ROUND_LENGTH_BLOCKS = 300;

    /*
     * BLOCK NUMBER WIDTHS — stated rather than suppressed.
     *
     * Block numbers are stored narrowed: `uint32` inside `Player` (to keep it to one slot) and
     * `uint48` inside `Round`. `uint32` overflows at 4,294,967,295 blocks, which at the measured
     * 300ms cadence is roughly 40 years of chain history; `uint48` is ~2.7 million years. Monad
     * testnet is far below both. Past the `uint32` bound the truncated comparison in
     * `AlreadyActedThisBlock` would alias and the one-step-per-block rule would break, so this is
     * a real (if distant) limit and not a claim of unconditional safety. It is recorded here
     * instead of being hidden behind a lint suppression.
     */

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Per-player race state, packed into a SINGLE 256-bit storage slot.
     * @dev 16 + 32 + 32 + 8 = 88 bits, so the struct occupies one slot and a single `SSTORE`
     *      updates a player's entire state. Under MIP-8 page-ified storage (4KB pages of 128
     *      contiguous slots) a one-slot player record also means one player touches one page.
     * @param pos Steps completed this round, 0..TRACK_LENGTH.
     * @param roundId The round this record belongs to. If it differs from `round.id` the record
     *        is stale leftover state from a past round and MUST read as "not joined". The views
     *        in this contract normalise that for you; a raw `players(addr)` read does not, so
     *        check the field yourself if you use it.
     * @param lastBlock Block number of this player's most recent `join()` or `step()`, used to
     *        enforce at most one action per block.
     * @param eliminated Whether this player landed in a red block. Permanent for the round.
     */
    struct Player {
        uint16 pos;
        uint32 roundId;
        uint32 lastBlock;
        bool eliminated;
    }

    /**
     * @notice Round lifecycle state, packed into a SINGLE 256-bit slot (32 + 48 + 48 = 128 bits)
     *         so the read `step()` performs on it costs one `SLOAD`.
     * @param id Current round id. 0 means no round has ever been started.
     * @param startBlock Block the round started at. This is the anchor the light schedule is
     *        measured from, so every round gets a different phase as well as a different shape.
     * @param endBlock Last block of the round (inclusive).
     */
    struct Round {
        uint32 id;
        uint48 startBlock;
        uint48 endBlock;
    }

    /// @notice Per-player state. The only mapping `step()` writes, and only ever the caller's own
    ///         entry.
    /// @dev Deliberately NOT accompanied by any aggregate counter. See design note 2.
    mapping(address => Player) public players;

    /// @notice Current round lifecycle state. Written only by `startRound()`.
    Round public round;

    /// @notice Winner of the current round, or `address(0)` if nobody has won it yet.
    /// @dev Written at most once per round, by the step that reaches `TRACK_LENGTH`. Cleared by
    ///      `startRound()`.
    address public roundWinner;

    /// @notice Everyone who joined a given round, in join order, so the stage view can enumerate
    ///         the field in one call.
    /// @dev The array-length slot here is the single point of write contention in this contract.
    ///      See design note 3.
    mapping(uint32 => address[]) private _roster;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Emitted when anyone starts a new round.
    event RoundStarted(uint32 indexed roundId, uint48 startBlock, uint48 endBlock);

    /// @notice Emitted when a player joins the current round.
    /// @dev Carries no block number on purpose: the log record already has one. Every event here
    ///      is kept to a minimum payload because Monad charges for the DECLARED gas limit, not
    ///      the gas used, so avoidable bytes are avoidable cost on every single move.
    event Joined(uint32 indexed roundId, address indexed player);

    /// @notice Emitted when a player advances on a green block.
    /// @param newPos The player's position after this step.
    event Stepped(uint32 indexed roundId, address indexed player, uint16 newPos);

    /// @notice Emitted when a player's step landed in a red block and eliminated them.
    /// @param posAtElimination The position they died on. They do not advance.
    event Eliminated(uint32 indexed roundId, address indexed player, uint16 posAtElimination);

    /// @notice Emitted when a player reaches `TRACK_LENGTH` and wins. Exactly one per round: the
    ///         winning step also ends the round, so no second player can finish it.
    event Won(uint32 indexed roundId, address indexed player);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    /// @notice Thrown by `startRound` when the current round is still running.
    error RoundActive();

    /// @notice Thrown when an action needs a live round and there isn't one.
    error RoundNotActive();

    /// @notice Thrown by `join` when the caller already joined the current round.
    error AlreadyJoined();

    /// @notice Thrown by `step` when the caller never joined the current round.
    error NotJoined();

    /// @notice Thrown by `step` when the caller was already eliminated this round.
    error PlayerEliminated();

    /// @notice Thrown by `step` when the caller already acted in this block. This rule is what
    ///         makes the game about nerve rather than clicking speed, and it bounds the load a
    ///         room can generate to one transaction per player per block.
    error AlreadyActedThisBlock();

    /**
     * @notice Thrown by `step` when it executed later than the deadline the player declared.
     * @dev THIS REVERT IS THE POINT, NOT A FAILURE. It is how a player refuses a move that has
     *      become too risky to make. Nothing is written and the player stays alive; they only
     *      lose the turn. Clients should present this as "missed the window", never as an error.
     * @param maxBlock The deadline the player declared.
     * @param currentBlock The block the transaction actually executed in.
     */
    error StepWindowMissed(uint32 maxBlock, uint256 currentBlock);

    /*//////////////////////////////////////////////////////////////
                            ROUND LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Permissionlessly start the next round. Anyone may call this once the previous round
     *         has ended, whether because its deadline passed or because somebody won. There is no
     *         admin key, so the game cannot stall waiting on an operator to reset it.
     * @dev Reverts with `RoundActive` if a round is still live.
     */
    function startRound() external {
        if (isRoundActive()) revert RoundActive();

        uint32 nextId = round.id + 1;
        uint48 startBlock = uint48(block.number);
        uint48 endBlock = uint48(block.number + ROUND_LENGTH_BLOCKS);

        round = Round({ id: nextId, startBlock: startBlock, endBlock: endBlock });
        roundWinner = address(0);

        emit RoundStarted(nextId, startBlock, endBlock);
    }

    /**
     * @notice Whether a round is currently accepting joins and steps.
     * @dev A round ends when its deadline passes OR the instant somebody wins, so a room can
     *      start a fresh round immediately after a win rather than waiting out the clock.
     */
    function isRoundActive() public view returns (bool) {
        Round memory r = round;
        return r.id != 0 && block.number <= r.endBlock && roundWinner == address(0);
    }

    /**
     * @notice Enter the current round at position 0.
     * @dev Sets `lastBlock` to the current block, so a player's first step must land in a strictly
     *      later block than their join. That keeps the one-action-per-block invariant uniform and
     *      stops a contract from joining and stepping atomically in one block.
     *
     *      This is the only function that writes shared state per player (the roster array's
     *      length slot). See design note 3.
     */
    function join() external {
        if (!isRoundActive()) revert RoundNotActive();

        uint32 roundId = round.id;
        if (players[msg.sender].roundId == roundId) revert AlreadyJoined();

        players[msg.sender] = Player({
            pos: 0,
            roundId: roundId,
            lastBlock: uint32(block.number),
            eliminated: false
        });

        _roster[roundId].push(msg.sender);

        emit Joined(roundId, msg.sender);
    }

    /**
     * @notice Take one step, but only if this transaction executes at or before `maxBlock`.
     *         Advances the caller by one if the block's light is green, and eliminates them if it
     *         is red.
     *
     * @dev THE DEADLINE IS THE GAME. `maxBlock` is the player's declared tolerance for inclusion
     *      risk. Reverting past it is a feature (design note 5): it converts "my transaction was
     *      unlucky" into "I chose how much luck to accept". Suggested client presets are
     *      `block.number + 1` (safe: refuse anything but near-immediate inclusion) and
     *      `block.number + 4` (dash: almost certainly lands, but may land after the light turns).
     *
     *      DOES NOT REVERT ON RED — see design note 4. Elimination is a state change and a revert
     *      would undo it. A successful transaction therefore does NOT mean a successful step;
     *      inspect the event.
     *
     *      Writes exactly one storage slot, `players[msg.sender]`, plus `roundWinner` on the one
     *      transaction per round that reaches `TRACK_LENGTH`.
     *
     * @param maxBlock The last block number at which the player is willing to have this executed.
     */
    function step(uint32 maxBlock) external {
        if (block.number > maxBlock) revert StepWindowMissed(maxBlock, block.number);

        Round memory r = round;
        if (r.id == 0 || block.number > r.endBlock || roundWinner != address(0)) revert RoundNotActive();

        Player memory p = players[msg.sender];
        if (p.roundId != r.id) revert NotJoined();
        if (p.eliminated) revert PlayerEliminated();
        if (p.lastBlock == uint32(block.number)) revert AlreadyActedThisBlock();

        p.lastBlock = uint32(block.number);

        if (lightAt(r.id, r.startBlock, block.number)) {
            p.pos += 1;
            players[msg.sender] = p;
            emit Stepped(r.id, msg.sender, p.pos);

            if (p.pos >= TRACK_LENGTH) {
                roundWinner = msg.sender;
                emit Won(r.id, msg.sender);
            }
        } else {
            p.eliminated = true;
            players[msg.sender] = p;
            emit Eliminated(r.id, msg.sender, p.pos);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                THE LIGHT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice The traffic light for `blockNumber`, as a pure function of public inputs.
     *
     * @dev THIS IS THE CANONICAL DEFINITION OF THE GAME'S CLOCK. The TypeScript port in
     *      `packages/nextjs/utils/red-light-green-block/light.ts` must agree with this function
     *      for every input, and a differential test asserts exactly that. A divergence would show
     *      players a different light from the one the chain enforces, which would look like the
     *      game cheating.
     *
     *      A round is divided into cycles of `CYCLE_LENGTH_BLOCKS`. Each cycle opens green for
     *      `greenBlocksInCycle(...)` blocks and is red for the rest, so the light always returns
     *      to green at a cycle boundary and no player can ever be stranded. The green length
     *      varies per cycle via `keccak256(abi.encode(roundId, cycleIndex))`, which keeps the
     *      schedule precomputable within a round but not memorisable across rounds.
     *
     *      Blocks before `roundStartBlock_` report green. No `step()` can execute in them, so
     *      this is a convention for chart rendering only, not a game rule.
     *
     * @param roundId_ The round whose schedule to evaluate.
     * @param roundStartBlock_ That round's start block — the schedule's anchor.
     * @param blockNumber The block to evaluate. May be past or future.
     * @return isGreen True if a step in that block advances, false if it eliminates.
     */
    function lightAt(uint32 roundId_, uint48 roundStartBlock_, uint256 blockNumber)
        public
        pure
        returns (bool isGreen)
    {
        if (blockNumber < roundStartBlock_) return true;

        uint256 elapsed = blockNumber - roundStartBlock_;
        return (elapsed % CYCLE_LENGTH_BLOCKS) < greenBlocksInCycle(roundId_, elapsed / CYCLE_LENGTH_BLOCKS);
    }

    /**
     * @notice How many blocks at the start of cycle `cycleIndex` are green in round `roundId_`.
     * @dev Always within `[MIN_GREEN_BLOCKS, MAX_GREEN_BLOCKS]`, and `MAX_GREEN_BLOCKS` is below
     *      `CYCLE_LENGTH_BLOCKS`, so every cycle contains at least one green and one red block.
     *      `abi.encode(uint32, uint256)` produces two 32-byte left-padded words; the TypeScript
     *      port must encode identically or the two schedules will silently diverge.
     */
    function greenBlocksInCycle(uint32 roundId_, uint256 cycleIndex) public pure returns (uint256) {
        uint256 span = MAX_GREEN_BLOCKS - MIN_GREEN_BLOCKS + 1;
        return MIN_GREEN_BLOCKS + (uint256(keccak256(abi.encode(roundId_, cycleIndex))) % span);
    }

    /**
     * @notice The next block at which the light changes colour, strictly after `blockNumber`.
     * @dev Pure, so a client can lay out an entire round's schedule offline. This is what lets the
     *      UI say "green for 3 more blocks" without asking the chain anything.
     */
    function nextLightChangeAfter(uint32 roundId_, uint48 roundStartBlock_, uint256 blockNumber)
        public
        pure
        returns (uint256 changeBlock)
    {
        if (blockNumber < roundStartBlock_) return roundStartBlock_;

        uint256 elapsed = blockNumber - roundStartBlock_;
        uint256 cycleIndex = elapsed / CYCLE_LENGTH_BLOCKS;
        uint256 cycleStart = uint256(roundStartBlock_) + cycleIndex * CYCLE_LENGTH_BLOCKS;
        uint256 green = greenBlocksInCycle(roundId_, cycleIndex);

        // In the green phase the change is where green runs out; in the red phase it is the next
        // cycle boundary, which always opens green.
        if (elapsed % CYCLE_LENGTH_BLOCKS < green) return cycleStart + green;
        return cycleStart + CYCLE_LENGTH_BLOCKS;
    }

    /**
     * @notice The light for `blockNumber` in the CURRENT round. Convenience only.
     * @dev Clients should call the `pure` `lightAt` locally rather than spending an `eth_call` on
     *      this. It exists for debugging and for on-chain integrations.
     */
    function isGreenAt(uint256 blockNumber) public view returns (bool) {
        Round memory r = round;
        return lightAt(r.id, r.startBlock, blockNumber);
    }

    /// @notice The light for the block this call executes in.
    function isGreenNow() external view returns (bool) {
        return isGreenAt(block.number);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice A player's state, normalised so a stale record from a previous round reads as "not
     *         joined" instead of leaking an old position.
     * @return joined Whether the player is in the current round.
     * @return pos Steps completed this round (0 if not joined).
     * @return eliminated Whether they were eliminated this round.
     * @return lastBlock Block of their last action this round (0 if not joined).
     */
    function getPlayer(address addr)
        public
        view
        returns (bool joined, uint16 pos, bool eliminated, uint32 lastBlock)
    {
        Player memory p = players[addr];
        if (round.id == 0 || p.roundId != round.id) return (false, 0, false, 0);
        return (true, p.pos, p.eliminated, p.lastBlock);
    }

    /// @notice Normalised player state, in the shape the batch view returns.
    struct PlayerView {
        address addr;
        bool joined;
        uint16 pos;
        bool eliminated;
        uint32 lastBlock;
    }

    /**
     * @notice Read many players in a single call.
     * @dev The stage view uses this so refreshing a room of 60 players costs ONE `eth_call`
     *      instead of 60. Since rate limits are per IP and a venue shares one, batching here is a
     *      requirement rather than an optimisation. Iteration is bounded by the caller's array;
     *      the roster views are paginated so callers can keep it to a sane size.
     */
    function getPlayers(address[] calldata addrs) external view returns (PlayerView[] memory out) {
        out = new PlayerView[](addrs.length);
        uint32 currentId = round.id;

        for (uint256 i = 0; i < addrs.length; i++) {
            Player memory p = players[addrs[i]];
            bool joined = currentId != 0 && p.roundId == currentId;
            out[i] = PlayerView({
                addr: addrs[i],
                joined: joined,
                pos: joined ? p.pos : 0,
                eliminated: joined ? p.eliminated : false,
                lastBlock: joined ? p.lastBlock : 0
            });
        }
    }

    /// @notice How many players joined `roundId_`.
    function rosterLength(uint32 roundId_) external view returns (uint256) {
        return _roster[roundId_].length;
    }

    /**
     * @notice A page of `roundId_`'s roster, in join order.
     * @dev Paginated so a large field can never make this view unreadable. A `start` past the end
     *      returns an empty array rather than reverting, so a caller paging blindly terminates
     *      cleanly.
     */
    function getRoster(uint32 roundId_, uint256 start, uint256 count)
        external
        view
        returns (address[] memory page)
    {
        address[] storage all = _roster[roundId_];
        uint256 len = all.length;
        if (start >= len) return new address[](0);

        uint256 end = start + count;
        if (end > len) end = len;

        page = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            page[i - start] = all[i];
        }
    }

    /**
     * @notice Everything a client needs to bootstrap, in a single `eth_call`.
     * @dev After this one call a client can compute the light for every block of the round locally
     *      and never has to ask the chain about the light again. `currentBlock` is returned so a
     *      client can align its local block clock without spending a second request on
     *      `eth_blockNumber`.
     */
    function getRoundInfo()
        external
        view
        returns (
            uint32 roundId,
            uint48 startBlock,
            uint48 endBlock,
            bool active,
            address winner,
            uint256 playerCount,
            uint256 currentBlock
        )
    {
        Round memory r = round;
        return (r.id, r.startBlock, r.endBlock, isRoundActive(), roundWinner, _roster[r.id].length, block.number);
    }
}
