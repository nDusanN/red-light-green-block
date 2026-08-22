// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../contracts/RedLightGreenBlock.sol";

/**
 * @title LightFixtureParityTest
 * @notice Asserts the Solidity light schedule still matches the committed parity fixture.
 *
 * @dev This is one half of the guard against the client and the chain disagreeing about what
 *      colour the light is. The other half is `packages/nextjs/utils/red-light-green-block/
 *      light.test.ts`, which checks the TypeScript port against the SAME file.
 *
 *      Neither test regenerates the fixture. That is deliberate: if a test regenerated it, a
 *      change to the schedule would quietly rewrite the reference and both tests would keep
 *      passing while the two implementations drifted apart. Because the fixture is committed data,
 *      a schedule change fails here loudly and the fix is to regenerate it on purpose
 *      (`yarn foundry:light-fixture`) and re-run the TypeScript test.
 *
 *      Transitively: Solidity == fixture and TypeScript == fixture, therefore Solidity ==
 *      TypeScript. Neither implementation ever has to import the other.
 */
contract LightFixtureParityTest is Test {
    RedLightGreenBlock internal game;
    string internal fixture;

    function setUp() public {
        game = new RedLightGreenBlock();
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/light-fixture.json"));
    }

    /// @dev If the constants move, every pattern in the fixture is meaningless — check them first
    ///      so the failure names the actual cause instead of showing a wall of mismatched blocks.
    function test_ConstantsMatchFixture() public view {
        assertEq(vm.parseJsonUint(fixture, ".cycleLengthBlocks"), game.CYCLE_LENGTH_BLOCKS());
        assertEq(vm.parseJsonUint(fixture, ".minGreenBlocks"), game.MIN_GREEN_BLOCKS());
        assertEq(vm.parseJsonUint(fixture, ".maxGreenBlocks"), game.MAX_GREEN_BLOCKS());
        assertEq(vm.parseJsonUint(fixture, ".trackLength"), uint256(game.TRACK_LENGTH()));
        assertEq(vm.parseJsonUint(fixture, ".roundLengthBlocks"), game.ROUND_LENGTH_BLOCKS());
    }

    function test_LightPatternsMatchFixture() public view {
        uint256 seriesCount = vm.parseJsonUint(fixture, ".seriesCount");
        assertGt(seriesCount, 0, "fixture has no series");

        uint256 totalBlocks;

        for (uint256 s = 0; s < seriesCount; s++) {
            string memory base = string.concat(".series[", vm.toString(s), "]");

            uint32 roundId = uint32(vm.parseJsonUint(fixture, string.concat(base, ".roundId")));
            uint48 startBlock = uint48(vm.parseJsonUint(fixture, string.concat(base, ".startBlock")));
            uint256 firstBlock = vm.parseJsonUint(fixture, string.concat(base, ".firstBlock"));
            bytes memory pattern = bytes(vm.parseJsonString(fixture, string.concat(base, ".pattern")));

            for (uint256 i = 0; i < pattern.length; i++) {
                bool expected = pattern[i] == bytes1("G");
                bool actual = game.lightAt(roundId, startBlock, firstBlock + i);
                assertEq(
                    actual,
                    expected,
                    string.concat("light mismatch in series ", vm.toString(s), " at offset ", vm.toString(i))
                );
            }

            totalBlocks += pattern.length;
        }

        console.log("light blocks checked against fixture:", totalBlocks);
    }

    function test_GreenLengthsMatchFixture() public view {
        uint256 seriesCount = vm.parseJsonUint(fixture, ".seriesCount");

        for (uint256 s = 0; s < seriesCount; s++) {
            string memory base = string.concat(".series[", vm.toString(s), "]");
            uint32 roundId = uint32(vm.parseJsonUint(fixture, string.concat(base, ".roundId")));
            uint256[] memory expected = vm.parseJsonUintArray(fixture, string.concat(base, ".greenLengths"));

            for (uint256 c = 0; c < expected.length; c++) {
                assertEq(
                    game.greenBlocksInCycle(roundId, c),
                    expected[c],
                    string.concat("green length mismatch, series ", vm.toString(s), " cycle ", vm.toString(c))
                );
            }
        }
    }

    function test_ChangeBlocksMatchFixture() public view {
        uint256 seriesCount = vm.parseJsonUint(fixture, ".seriesCount");

        for (uint256 s = 0; s < seriesCount; s++) {
            string memory base = string.concat(".series[", vm.toString(s), "]");
            uint32 roundId = uint32(vm.parseJsonUint(fixture, string.concat(base, ".roundId")));
            uint48 startBlock = uint48(vm.parseJsonUint(fixture, string.concat(base, ".startBlock")));

            uint256 pairCount = vm.parseJsonUint(fixture, ".changeBlockCount");
            for (uint256 p = 0; p < pairCount; p++) {
                uint256[] memory pair =
                    vm.parseJsonUintArray(fixture, string.concat(base, ".changeBlocks[", vm.toString(p), "]"));
                assertEq(
                    game.nextLightChangeAfter(roundId, startBlock, pair[0]),
                    pair[1],
                    string.concat("next change mismatch, series ", vm.toString(s))
                );
            }
        }
    }
}
