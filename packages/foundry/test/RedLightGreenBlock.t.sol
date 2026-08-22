// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/RedLightGreenBlock.sol";

/**
 * @title RedLightGreenBlockTest
 * @notice Behavioural tests for the race contract.
 *
 * @dev The light is a deterministic function of the block number, so these tests never assume a
 *      given block is green or red. They locate the next block of the colour they need with
 *      `_nextGreen` / `_nextRed`, which call the contract's own `lightAt`. That keeps the tests
 *      honest about *behaviour* (green advances, red eliminates) and leaves the *schedule* itself
 *      to be pinned separately by the structural and statistical tests further down, plus the
 *      TypeScript differential test.
 */
contract RedLightGreenBlockTest is Test {
    RedLightGreenBlock internal game;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);

    // Mirrors of the contract's events, needed for `vm.expectEmit`.
    event RoundStarted(uint32 indexed roundId, uint48 startBlock, uint48 endBlock);
    event Joined(uint32 indexed roundId, address indexed player);
    event Stepped(uint32 indexed roundId, address indexed player, uint16 newPos);
    event Eliminated(uint32 indexed roundId, address indexed player, uint16 posAtElimination);
    event Won(uint32 indexed roundId, address indexed player);

    function setUp() public {
        game = new RedLightGreenBlock();
        vm.roll(1_000);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Current round id and start block, read once.
    function _round() internal view returns (uint32 id, uint48 startBlock) {
        (id, startBlock,) = game.round();
    }

    /// @dev First block strictly after `from` whose light is green.
    function _nextGreen(uint256 from) internal view returns (uint256) {
        (uint32 id, uint48 start) = _round();
        for (uint256 b = from + 1; b < from + 500; b++) {
            if (game.lightAt(id, start, b)) return b;
        }
        revert("no green block found within 500");
    }

    /// @dev First block strictly after `from` whose light is red.
    function _nextRed(uint256 from) internal view returns (uint256) {
        (uint32 id, uint48 start) = _round();
        for (uint256 b = from + 1; b < from + 500; b++) {
            if (!game.lightAt(id, start, b)) return b;
        }
        revert("no red block found within 500");
    }

    /// @dev Roll to the next green block and take a step that cannot miss its window.
    function _stepOnNextGreen(address who) internal {
        uint256 target = _nextGreen(block.number);
        vm.roll(target);
        vm.prank(who);
        game.step(uint32(target));
    }

    function _startAndJoin(address who) internal {
        game.startRound();
        vm.prank(who);
        game.join();
    }

    /*//////////////////////////////////////////////////////////////
                             ROUND LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function test_NoRoundActiveBeforeFirstStart() public view {
        assertFalse(game.isRoundActive());
        (uint32 id,,) = game.round();
        assertEq(id, 0);
    }

    function test_StartRound_IsPermissionlessAndSetsState() public {
        vm.expectEmit(true, false, false, true);
        emit RoundStarted(1, uint48(block.number), uint48(block.number + game.ROUND_LENGTH_BLOCKS()));

        // Called by an arbitrary address: there is no owner and no access control.
        vm.prank(address(0xDEAD));
        game.startRound();

        (uint32 id, uint48 startBlock, uint48 endBlock) = game.round();
        assertEq(id, 1);
        assertEq(startBlock, uint48(block.number));
        assertEq(endBlock, uint48(block.number + game.ROUND_LENGTH_BLOCKS()));
        assertTrue(game.isRoundActive());
        assertEq(game.roundWinner(), address(0));
    }

    function test_StartRound_RevertsWhileActive() public {
        game.startRound();
        vm.expectRevert(RedLightGreenBlock.RoundActive.selector);
        game.startRound();
    }

    function test_RoundEndsAtDeadlineAndAnyoneCanStartTheNext() public {
        game.startRound();
        (,, uint48 endBlock) = game.round();

        vm.roll(endBlock);
        assertTrue(game.isRoundActive(), "still active on the final block");

        vm.roll(uint256(endBlock) + 1);
        assertFalse(game.isRoundActive(), "inactive one block past the deadline");

        vm.prank(carol);
        game.startRound();
        (uint32 id,,) = game.round();
        assertEq(id, 2);
    }

    /*//////////////////////////////////////////////////////////////
                                  JOIN
    //////////////////////////////////////////////////////////////*/

    function test_Join_SetsStateAndRoster() public {
        game.startRound();

        vm.expectEmit(true, true, false, false);
        emit Joined(1, alice);
        vm.prank(alice);
        game.join();

        (bool joined, uint16 pos, bool eliminated, uint32 lastBlock) = game.getPlayer(alice);
        assertTrue(joined);
        assertEq(pos, 0);
        assertFalse(eliminated);
        assertEq(lastBlock, uint32(block.number));

        assertEq(game.rosterLength(1), 1);
        address[] memory page = game.getRoster(1, 0, 10);
        assertEq(page.length, 1);
        assertEq(page[0], alice);
    }

    function test_Join_RevertsWhenNoRound() public {
        vm.expectRevert(RedLightGreenBlock.RoundNotActive.selector);
        vm.prank(alice);
        game.join();
    }

    function test_Join_RevertsOnDoubleJoin() public {
        _startAndJoin(alice);
        vm.expectRevert(RedLightGreenBlock.AlreadyJoined.selector);
        vm.prank(alice);
        game.join();
    }

    function test_Join_CannotStepInTheSameBlockAsJoining() public {
        game.startRound();
        // Roll to a green block first, so the only thing that can stop the step is the
        // one-action-per-block rule rather than the light.
        uint256 green = _nextGreen(block.number);
        vm.roll(green);

        vm.prank(alice);
        game.join();

        vm.expectRevert(RedLightGreenBlock.AlreadyActedThisBlock.selector);
        vm.prank(alice);
        game.step(uint32(green));
    }

    /*//////////////////////////////////////////////////////////////
                              STEPPING
    //////////////////////////////////////////////////////////////*/

    function test_Step_GreenAdvancesByOne() public {
        _startAndJoin(alice);

        uint256 green = _nextGreen(block.number);
        vm.roll(green);

        vm.expectEmit(true, true, false, true);
        emit Stepped(1, alice, 1);
        vm.prank(alice);
        game.step(uint32(green));

        (, uint16 pos, bool eliminated,) = game.getPlayer(alice);
        assertEq(pos, 1);
        assertFalse(eliminated);
    }

    function test_Step_RedEliminatesWithoutReverting() public {
        _startAndJoin(alice);

        uint256 red = _nextRed(block.number);
        vm.roll(red);

        // The call must SUCCEED. If it reverted, the elimination would be rolled back and the
        // punishment would silently never happen.
        vm.expectEmit(true, true, false, true);
        emit Eliminated(1, alice, 0);
        vm.prank(alice);
        game.step(uint32(red));

        (, uint16 pos, bool eliminated,) = game.getPlayer(alice);
        assertEq(pos, 0, "no advance on red");
        assertTrue(eliminated);
    }

    function test_Step_RedEliminatesAtWhateverPositionYouReached() public {
        _startAndJoin(alice);
        _stepOnNextGreen(alice);
        _stepOnNextGreen(alice);

        (, uint16 posBefore,,) = game.getPlayer(alice);
        assertEq(posBefore, 2);

        uint256 red = _nextRed(block.number);
        vm.roll(red);
        vm.expectEmit(true, true, false, true);
        emit Eliminated(1, alice, 2);
        vm.prank(alice);
        game.step(uint32(red));
    }

    function test_Step_EliminationIsPermanent() public {
        _startAndJoin(alice);

        uint256 red = _nextRed(block.number);
        vm.roll(red);
        vm.prank(alice);
        game.step(uint32(red));

        // Even on a green block, later, an eliminated player stays out.
        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.expectRevert(RedLightGreenBlock.PlayerEliminated.selector);
        vm.prank(alice);
        game.step(uint32(green));

        (, uint16 pos, bool eliminated,) = game.getPlayer(alice);
        assertEq(pos, 0);
        assertTrue(eliminated);
    }

    function test_Step_OnlyOncePerBlock() public {
        _startAndJoin(alice);

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.prank(alice);
        game.step(uint32(green));

        vm.expectRevert(RedLightGreenBlock.AlreadyActedThisBlock.selector);
        vm.prank(alice);
        game.step(uint32(green));

        (, uint16 pos,,) = game.getPlayer(alice);
        assertEq(pos, 1, "the second call in the same block must not advance the player");
    }

    function test_Step_RevertsIfNeverJoined() public {
        game.startRound();
        uint256 green = _nextGreen(block.number);
        vm.roll(green);

        vm.expectRevert(RedLightGreenBlock.NotJoined.selector);
        vm.prank(alice);
        game.step(uint32(green));
    }

    function test_Step_RevertsWhenRoundInactive() public {
        _startAndJoin(alice);
        (,, uint48 endBlock) = game.round();
        vm.roll(uint256(endBlock) + 1);

        vm.expectRevert(RedLightGreenBlock.RoundNotActive.selector);
        vm.prank(alice);
        game.step(type(uint32).max);
    }

    /*//////////////////////////////////////////////////////////////
              THE maxBlock DEADLINE — THE FAIRNESS GUARANTEE
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev The central fairness property: a transaction that executes later than the player was
     *      willing to accept must do NOTHING. Not advance, and crucially not eliminate. Without
     *      this, a correctly-timed move that slipped a block under load could kill a player
     *      through no fault of their own, and elimination would be partly a mempool lottery.
     */
    function test_Step_MissedWindowOnARedBlockLeavesPlayerAliveAndUnchanged() public {
        _startAndJoin(alice);
        _stepOnNextGreen(alice);

        (, uint16 posBefore,, uint32 lastBlockBefore) = game.getPlayer(alice);
        assertEq(posBefore, 1);

        // The player aimed at an earlier block; the transaction landed late, in a red block.
        uint256 red = _nextRed(block.number);
        vm.roll(red);
        uint32 declaredDeadline = uint32(red - 1);

        vm.expectRevert(
            abi.encodeWithSelector(RedLightGreenBlock.StepWindowMissed.selector, declaredDeadline, red)
        );
        vm.prank(alice);
        game.step(declaredDeadline);

        (bool joined, uint16 posAfter, bool eliminated, uint32 lastBlockAfter) = game.getPlayer(alice);
        assertTrue(joined);
        assertEq(posAfter, posBefore, "position unchanged");
        assertFalse(eliminated, "a missed window must never eliminate");
        assertEq(lastBlockAfter, lastBlockBefore, "no action was recorded, so the turn is reusable");
    }

    function test_Step_MissedWindowOnAGreenBlockDoesNotAdvance() public {
        _startAndJoin(alice);

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        uint32 declaredDeadline = uint32(green - 1);

        vm.expectRevert(
            abi.encodeWithSelector(RedLightGreenBlock.StepWindowMissed.selector, declaredDeadline, green)
        );
        vm.prank(alice);
        game.step(declaredDeadline);

        (, uint16 pos,,) = game.getPlayer(alice);
        assertEq(pos, 0);
    }

    function test_Step_DeadlineIsInclusive() public {
        _startAndJoin(alice);
        uint256 green = _nextGreen(block.number);
        vm.roll(green);

        // maxBlock == block.number must be accepted: the player said "up to and including".
        vm.prank(alice);
        game.step(uint32(green));

        (, uint16 pos,,) = game.getPlayer(alice);
        assertEq(pos, 1);
    }

    function test_Step_GenerousDeadlineStillEliminatesOnRed() public {
        _startAndJoin(alice);
        uint256 red = _nextRed(block.number);
        vm.roll(red);

        // A "dash" deadline reaching past the light change is exactly the wager the player took.
        vm.prank(alice);
        game.step(uint32(red + 4));

        (,, bool eliminated,) = game.getPlayer(alice);
        assertTrue(eliminated, "accepting a wide window means accepting the red risk");
    }

    /// @dev A missed window costs nothing, so the player can retry in the very next block.
    function test_Step_CanRetryImmediatelyAfterMissedWindow() public {
        _startAndJoin(alice);

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.expectRevert(
            abi.encodeWithSelector(RedLightGreenBlock.StepWindowMissed.selector, uint32(green - 1), green)
        );
        vm.prank(alice);
        game.step(uint32(green - 1));

        // Same block, correct deadline this time.
        vm.prank(alice);
        game.step(uint32(green));

        (, uint16 pos,,) = game.getPlayer(alice);
        assertEq(pos, 1);
    }

    /*//////////////////////////////////////////////////////////////
                            WINNING A ROUND
    //////////////////////////////////////////////////////////////*/

    function test_Win_ReachingTrackLengthWinsAndEndsTheRound() public {
        _startAndJoin(alice);

        uint16 track = game.TRACK_LENGTH();
        for (uint256 i = 0; i < track - 1; i++) {
            _stepOnNextGreen(alice);
        }

        (, uint16 pos,,) = game.getPlayer(alice);
        assertEq(pos, track - 1);
        assertTrue(game.isRoundActive());

        uint256 finalGreen = _nextGreen(block.number);
        vm.roll(finalGreen);
        vm.expectEmit(true, true, false, false);
        emit Won(1, alice);
        vm.prank(alice);
        game.step(uint32(finalGreen));

        assertEq(game.roundWinner(), alice);
        assertFalse(game.isRoundActive(), "a win ends the round immediately");

        (, uint16 finalPos,,) = game.getPlayer(alice);
        assertEq(finalPos, track);
    }

    function test_Win_OtherPlayersCannotStepAfterTheRoundIsWon() public {
        _startAndJoin(alice);
        vm.prank(bob);
        game.join();

        uint16 track = game.TRACK_LENGTH();
        for (uint256 i = 0; i < track; i++) {
            _stepOnNextGreen(alice);
        }
        assertEq(game.roundWinner(), alice);

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.expectRevert(RedLightGreenBlock.RoundNotActive.selector);
        vm.prank(bob);
        game.step(uint32(green));
    }

    function test_Win_NextRoundCanStartImmediately() public {
        _startAndJoin(alice);
        for (uint256 i = 0; i < game.TRACK_LENGTH(); i++) {
            _stepOnNextGreen(alice);
        }

        vm.prank(bob);
        game.startRound();

        (uint32 id,,) = game.round();
        assertEq(id, 2);
        assertEq(game.roundWinner(), address(0), "winner is cleared for the new round");
        assertTrue(game.isRoundActive());
    }

    /*//////////////////////////////////////////////////////////////
                     STALE STATE ACROSS ROUNDS
    //////////////////////////////////////////////////////////////*/

    function test_StaleStateFromAPreviousRoundReadsAsEmpty() public {
        _startAndJoin(alice);
        _stepOnNextGreen(alice);
        _stepOnNextGreen(alice);

        (, uint16 pos,,) = game.getPlayer(alice);
        assertEq(pos, 2);

        (,, uint48 endBlock) = game.round();
        vm.roll(uint256(endBlock) + 1);
        game.startRound();

        // The raw mapping still holds round 1's record...
        (uint16 rawPos, uint32 rawRoundId,,) = game.players(alice);
        assertEq(rawPos, 2);
        assertEq(rawRoundId, 1);

        // ...but every normalising view reports "not joined".
        (bool joined, uint16 viewPos, bool eliminated, uint32 lastBlock) = game.getPlayer(alice);
        assertFalse(joined);
        assertEq(viewPos, 0);
        assertFalse(eliminated);
        assertEq(lastBlock, 0);

        address[] memory addrs = new address[](1);
        addrs[0] = alice;
        RedLightGreenBlock.PlayerView[] memory views = game.getPlayers(addrs);
        assertFalse(views[0].joined);
        assertEq(views[0].pos, 0);
    }

    function test_EliminatedPlayerIsAliveAgainInTheNextRound() public {
        _startAndJoin(alice);
        uint256 red = _nextRed(block.number);
        vm.roll(red);
        vm.prank(alice);
        game.step(uint32(red));
        (,, bool eliminated,) = game.getPlayer(alice);
        assertTrue(eliminated);

        (,, uint48 endBlock) = game.round();
        vm.roll(uint256(endBlock) + 1);
        game.startRound();

        vm.prank(alice);
        game.join();

        (bool joined, uint16 pos, bool stillEliminated,) = game.getPlayer(alice);
        assertTrue(joined);
        assertEq(pos, 0);
        assertFalse(stillEliminated);
    }

    function test_RosterIsPerRound() public {
        _startAndJoin(alice);
        vm.prank(bob);
        game.join();
        assertEq(game.rosterLength(1), 2);

        (,, uint48 endBlock) = game.round();
        vm.roll(uint256(endBlock) + 1);
        game.startRound();

        assertEq(game.rosterLength(2), 0, "round 2 starts with an empty roster");
        assertEq(game.rosterLength(1), 2, "round 1's roster is untouched");

        vm.prank(carol);
        game.join();
        assertEq(game.rosterLength(2), 1);
    }

    /*//////////////////////////////////////////////////////////////
                          THE LIGHT SCHEDULE
    //////////////////////////////////////////////////////////////*/

    function test_Light_GreenLengthAlwaysWithinBounds() public view {
        for (uint256 cycle = 0; cycle < 200; cycle++) {
            uint256 green = game.greenBlocksInCycle(1, cycle);
            assertGe(green, game.MIN_GREEN_BLOCKS());
            assertLe(green, game.MAX_GREEN_BLOCKS());
            assertLt(green, game.CYCLE_LENGTH_BLOCKS(), "every cycle must contain at least one red block");
        }
    }

    function testFuzz_Light_GreenLengthAlwaysWithinBounds(uint32 roundId, uint256 cycleIndex) public view {
        uint256 green = game.greenBlocksInCycle(roundId, cycleIndex);
        assertGe(green, game.MIN_GREEN_BLOCKS());
        assertLe(green, game.MAX_GREEN_BLOCKS());
        assertLt(green, game.CYCLE_LENGTH_BLOCKS());
    }

    function test_Light_EveryCycleOpensGreenAndClosesRed() public view {
        uint48 start = 1_000;
        uint256 cycleLen = game.CYCLE_LENGTH_BLOCKS();

        for (uint256 cycle = 0; cycle < 50; cycle++) {
            uint256 cycleStart = uint256(start) + cycle * cycleLen;
            assertTrue(game.lightAt(1, start, cycleStart), "a cycle always opens green");
            assertFalse(game.lightAt(1, start, cycleStart + cycleLen - 1), "a cycle always ends red");
        }
    }

    function test_Light_IsGreenBeforeTheRoundStarts() public view {
        assertTrue(game.lightAt(1, 1_000, 999));
        assertTrue(game.lightAt(1, 1_000, 0));
    }

    function test_Light_DiffersBetweenRounds() public view {
        // Not a cryptographic claim, just a sanity check that roundId actually feeds the schedule
        // so a player cannot memorise one round and replay it in the next.
        uint256 differences;
        for (uint256 cycle = 0; cycle < 100; cycle++) {
            if (game.greenBlocksInCycle(1, cycle) != game.greenBlocksInCycle(2, cycle)) differences++;
        }
        assertGt(differences, 50, "round id must materially change the schedule");
    }

    /**
     * @dev Measures the actual green share and green run lengths over 20,000 blocks. This is a
     *      measurement of this exact implementation, logged so the README can quote a number that
     *      came from a real run rather than from arithmetic on the constants.
     */
    function test_Light_MeasuredGreenShareAndRunLengths() public view {
        uint48 start = 1_000;
        uint256 samples = 20_000;
        uint256 greenCount;
        uint256 minRun = type(uint256).max;
        uint256 maxRun;
        uint256 currentRun;

        for (uint256 i = 0; i < samples; i++) {
            if (game.lightAt(1, start, uint256(start) + i)) {
                greenCount++;
                currentRun++;
            } else if (currentRun > 0) {
                if (currentRun < minRun) minRun = currentRun;
                if (currentRun > maxRun) maxRun = currentRun;
                currentRun = 0;
            }
        }

        uint256 sharePermille = (greenCount * 1000) / samples;
        console.log("green share (permille):", sharePermille);
        console.log("green run min blocks:  ", minRun);
        console.log("green run max blocks:  ", maxRun);

        // Green must be near half the time: enough momentum to be fun, enough red to be lethal.
        assertGt(sharePermille, 450, "green share should be near 50%");
        assertLt(sharePermille, 600, "green share should be near 50%");
        assertEq(minRun, game.MIN_GREEN_BLOCKS());
        assertEq(maxRun, game.MAX_GREEN_BLOCKS());
    }

    /**
     * @dev `nextLightChangeAfter` is what the UI uses to say "green for 3 more blocks", so it must
     *      agree with `lightAt` exactly. This walks 4,000 blocks and checks that the reported
     *      change block is the first block whose colour actually differs.
     */
    function test_Light_NextChangeAgreesWithLightAt() public view {
        uint48 start = 1_000;

        for (uint256 i = 0; i < 4_000; i++) {
            uint256 b = uint256(start) + i;
            bool here = game.lightAt(1, start, b);
            uint256 change = game.nextLightChangeAfter(1, start, b);

            assertGt(change, b, "the change must be strictly in the future");
            assertTrue(game.lightAt(1, start, change) != here, "the colour must actually differ there");

            // ...and nothing in between may differ.
            for (uint256 mid = b + 1; mid < change; mid++) {
                assertEq(game.lightAt(1, start, mid), here, "colour must be stable until the change block");
            }
        }
    }

    function testFuzz_Light_NextChangeIsAlwaysAColourFlip(uint32 roundId, uint16 offset) public view {
        uint48 start = 1_000;
        uint256 b = uint256(start) + offset;
        uint256 change = game.nextLightChangeAfter(roundId, start, b);
        assertGt(change, b);
        assertTrue(game.lightAt(roundId, start, change) != game.lightAt(roundId, start, b));
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function test_GetRoundInfo() public {
        game.startRound();
        vm.prank(alice);
        game.join();
        vm.prank(bob);
        game.join();

        (
            uint32 roundId,
            uint48 startBlock,
            uint48 endBlock,
            bool active,
            address winner,
            uint256 playerCount,
            uint256 currentBlock
        ) = game.getRoundInfo();

        assertEq(roundId, 1);
        assertEq(startBlock, uint48(block.number));
        assertEq(endBlock, uint48(block.number + game.ROUND_LENGTH_BLOCKS()));
        assertTrue(active);
        assertEq(winner, address(0));
        assertEq(playerCount, 2);
        assertEq(currentBlock, block.number);
    }

    function test_GetPlayers_BatchMatchesIndividualReads() public {
        _startAndJoin(alice);
        vm.prank(bob);
        game.join();
        _stepOnNextGreen(alice);

        address[] memory addrs = new address[](3);
        addrs[0] = alice;
        addrs[1] = bob;
        addrs[2] = carol; // never joined

        RedLightGreenBlock.PlayerView[] memory views = game.getPlayers(addrs);
        assertEq(views.length, 3);

        for (uint256 i = 0; i < addrs.length; i++) {
            (bool joined, uint16 pos, bool eliminated, uint32 lastBlock) = game.getPlayer(addrs[i]);
            assertEq(views[i].addr, addrs[i]);
            assertEq(views[i].joined, joined);
            assertEq(views[i].pos, pos);
            assertEq(views[i].eliminated, eliminated);
            assertEq(views[i].lastBlock, lastBlock);
        }

        assertEq(views[0].pos, 1);
        assertTrue(views[1].joined);
        assertFalse(views[2].joined);
    }

    function test_GetRoster_Pagination() public {
        game.startRound();
        for (uint160 i = 1; i <= 25; i++) {
            vm.prank(address(i));
            game.join();
        }
        assertEq(game.rosterLength(1), 25);

        address[] memory firstPage = game.getRoster(1, 0, 10);
        assertEq(firstPage.length, 10);
        assertEq(firstPage[0], address(1));
        assertEq(firstPage[9], address(10));

        // A page that runs off the end is clamped rather than reverting.
        address[] memory lastPage = game.getRoster(1, 20, 10);
        assertEq(lastPage.length, 5);
        assertEq(lastPage[4], address(25));

        // Starting past the end terminates cleanly, so a caller can page blindly.
        assertEq(game.getRoster(1, 25, 10).length, 0);
        assertEq(game.getRoster(1, 999, 10).length, 0);
    }

    function test_IsGreenNowMatchesPureLightAt() public {
        game.startRound();
        (uint32 id, uint48 start) = _round();

        for (uint256 i = 0; i < 120; i++) {
            vm.roll(uint256(start) + i);
            assertEq(game.isGreenNow(), game.lightAt(id, start, block.number));
            assertEq(game.isGreenAt(block.number), game.lightAt(id, start, block.number));
        }
    }

    /*//////////////////////////////////////////////////////////////
                        MULTI-PLAYER INDEPENDENCE
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Two players stepping in the same block must not affect each other's state at all. This
     *      is the observable half of the parallel-execution design claim: the contract cannot
     *      prove a node ran them concurrently, but it can prove neither one's step reads or writes
     *      anything belonging to the other.
     */
    function test_TwoPlayersInTheSameBlockDoNotAffectEachOther() public {
        _startAndJoin(alice);
        vm.prank(bob);
        game.join();

        _stepOnNextGreen(alice);
        _stepOnNextGreen(alice);

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.prank(bob);
        game.step(uint32(green));
        vm.prank(alice);
        game.step(uint32(green));

        (, uint16 alicePos, bool aliceOut,) = game.getPlayer(alice);
        (, uint16 bobPos, bool bobOut,) = game.getPlayer(bob);
        assertEq(alicePos, 3);
        assertEq(bobPos, 1);
        assertFalse(aliceOut);
        assertFalse(bobOut);
    }

    function test_OnePlayersEliminationDoesNotAffectAnother() public {
        _startAndJoin(alice);
        vm.prank(bob);
        game.join();

        uint256 red = _nextRed(block.number);
        vm.roll(red);
        vm.prank(alice);
        game.step(uint32(red));

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.prank(bob);
        game.step(uint32(green));

        (, uint16 alicePos, bool aliceOut,) = game.getPlayer(alice);
        (, uint16 bobPos, bool bobOut,) = game.getPlayer(bob);
        assertTrue(aliceOut);
        assertEq(alicePos, 0);
        assertFalse(bobOut);
        assertEq(bobPos, 1);
    }

    /*//////////////////////////////////////////////////////////////
                            STORAGE PACKING
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Measures execution gas for each path of `step()` in isolation.
     *
     * @dev Monad charges for the DECLARED gas limit, not the gas actually used, so picking the
     *      limit is a real cost decision rather than a formality and it needs a real number
     *      behind it.
     *
     *      Two caveats on how to read these figures, both of which would otherwise inflate or
     *      deflate them misleadingly:
     *
     *      - Foundry runs a whole test as one transaction, so storage touched earlier in the test
     *        stays warm. A real step is its own transaction and hits a COLD player slot. `vm.cool`
     *        is called before each measurement to reproduce that.
     *      - These are EXECUTION gas only, as seen from inside the EVM. They EXCLUDE the 21,000
     *        intrinsic transaction cost and the calldata cost, so a live transaction costs more.
     *
     *      The README quotes `gasUsed` from real Monad testnet receipts for the number that
     *      actually matters. This test exists to catch a regression in the contract itself.
     */
    function test_MeasuredGasPerStepPath() public {
        _startAndJoin(alice);
        vm.prank(bob);
        game.join();
        vm.prank(carol);
        game.join();

        uint256 green = _nextGreen(block.number);
        vm.roll(green);
        vm.cool(address(game));
        vm.prank(alice);
        uint256 before = gasleft();
        game.step(uint32(green));
        console.log("step, green advance   (cold):", before - gasleft());

        uint256 red = _nextRed(block.number);
        vm.roll(red);
        vm.cool(address(game));
        vm.prank(bob);
        before = gasleft();
        game.step(uint32(red));
        console.log("step, red elimination (cold):", before - gasleft());

        vm.cool(address(game));
        vm.prank(carol);
        before = gasleft();
        try game.step(uint32(red - 1)) { revert("expected a missed window"); } catch { }
        console.log("step, missed window   (cold):", before - gasleft());

        (,, uint48 endBlock) = game.round();
        vm.roll(uint256(endBlock) + 1);
        game.startRound();

        // Join must be measured with a BRAND NEW address. Reusing an address that played a
        // previous round overwrites a non-zero player slot (5,000 gas) instead of writing a fresh
        // one (20,000), which understates the cost by enough to make a real join run out of gas.
        vm.cool(address(game));
        vm.prank(address(0xF1257));
        before = gasleft();
        game.join();
        console.log("join, new addr, 1st of round (cold):", before - gasleft());

        vm.prank(address(0xF1258));
        game.join();
        vm.cool(address(game));
        vm.prank(address(0xF1259));
        before = gasleft();
        game.join();
        console.log("join, new addr, mid-roster   (cold):", before - gasleft());

        vm.cool(address(game));
        vm.prank(alice);
        before = gasleft();
        game.join();
        console.log("join, returning player       (cold):", before - gasleft());

        // The winning step is the worst case: it also writes `roundWinner` from zero, which is a
        // fresh non-zero SSTORE. The declared gas limit has to cover THIS, not a typical step,
        // otherwise the only transaction that fails all round is the one that wins it.
        for (uint256 i = 0; i < game.TRACK_LENGTH() - 1; i++) {
            _stepOnNextGreen(alice);
        }
        uint256 finalGreen = _nextGreen(block.number);
        vm.roll(finalGreen);
        vm.cool(address(game));
        vm.prank(alice);
        before = gasleft();
        game.step(uint32(finalGreen));
        console.log("step, WINNING step           (cold):", before - gasleft());
        assertEq(game.roundWinner(), alice, "the measured step must actually be the winning one");
    }

    /**
     * @dev Asserts the whole `Player` struct really does live in one storage slot. If someone adds
     *      a field that spills into a second slot, `step()` silently becomes two `SSTORE`s and
     *      touches two MIP-8 pages, and this test is the thing that catches it.
     */
    function test_PlayerStructOccupiesExactlyOneSlot() public {
        _startAndJoin(alice);
        _stepOnNextGreen(alice);

        bytes32 slot = keccak256(abi.encode(alice, uint256(0))); // players is storage slot 0
        bytes32 packed = vm.load(address(game), slot);
        assertTrue(packed != bytes32(0), "player state must be in the first mapping slot");

        // pos (uint16) occupies the low 16 bits; roundId (uint32) the next 32.
        assertEq(uint256(packed) & 0xFFFF, 1, "pos");
        assertEq((uint256(packed) >> 16) & 0xFFFFFFFF, 1, "roundId");

        // Nothing may have spilled into the next slot.
        bytes32 next = vm.load(address(game), bytes32(uint256(slot) + 1));
        assertEq(next, bytes32(0), "Player must not spill into a second slot");
    }
}
