// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Script, console } from "forge-std/Script.sol";
import "../contracts/RedLightGreenBlock.sol";

/**
 * @notice Regenerates the light-schedule parity fixture from the Solidity implementation.
 *
 * @dev The fixture is the shared reference point between the two implementations of the light.
 *      `LightFixtureParity.t.sol` asserts Solidity still agrees with it, and `light.test.ts`
 *      asserts the TypeScript port agrees with it. Because the fixture is committed and neither
 *      test regenerates it, a change to either implementation shows up as a failure rather than as
 *      a quietly updated file.
 *
 *      That is the whole point: a client that computed the light one block differently from the
 *      chain would show a green light to a player the chain was about to eliminate, and the game
 *      would look both broken and rigged.
 *
 *      Run with: yarn foundry:light-fixture
 *
 *      The fixture lives in the Foundry package because that is where it is generated and because
 *      `fs_permissions` scopes writes to this package. The TypeScript test reads the same file
 *      rather than a copy — one file, two independent readers, so the two can never drift apart
 *      through a stale duplicate.
 *
 *      Colours are emitted as a run-length-free "GRGR..." string per series rather than as a row
 *      per block, which keeps a few thousand cases readable and diffable by eye.
 */
contract GenerateLightFixture is Script {
    /// @dev How many consecutive blocks each series covers.
    uint256 constant SERIES_LENGTH = 600;

    /// @dev How many cycles of green lengths to record per series.
    uint256 constant GREEN_LENGTH_COUNT = 40;

    /// @dev Number of sampled change-block pairs per series; must match the loop in `_changeBlocks`.
    function _changeBlockCount() internal pure returns (uint256 n) {
        for (uint256 i = 0; i < SERIES_LENGTH; i += 37) n++;
    }

    function run() external {
        RedLightGreenBlock game = new RedLightGreenBlock();

        // Deliberately awkward inputs, not just tidy ones: round 0 and round max exercise the
        // uint32 boundaries, start block 0 exercises the "no offset" case, and a start block above
        // the series start exercises the pre-round convention where the light reads green.
        uint32[6] memory roundIds = [uint32(1), 2, 3, 0, type(uint32).max, 7];
        uint48[6] memory startBlocks = [uint48(1000), 1000, 12345, 0, 999999999, 2000];
        uint256[6] memory firstBlocks = [uint256(1000), 1000, 12345, 0, 999999999, 1990];

        string memory json = "{\n";
        json = string.concat(json, '  "cycleLengthBlocks": ', vm.toString(game.CYCLE_LENGTH_BLOCKS()), ",\n");
        json = string.concat(json, '  "minGreenBlocks": ', vm.toString(game.MIN_GREEN_BLOCKS()), ",\n");
        json = string.concat(json, '  "maxGreenBlocks": ', vm.toString(game.MAX_GREEN_BLOCKS()), ",\n");
        json = string.concat(json, '  "trackLength": ', vm.toString(uint256(game.TRACK_LENGTH())), ",\n");
        json = string.concat(json, '  "roundLengthBlocks": ', vm.toString(game.ROUND_LENGTH_BLOCKS()), ",\n");
        // Counts are written explicitly because forge's JSON path syntax has no `.length`, and a
        // reader that cannot enumerate the fixture would silently verify nothing.
        json = string.concat(json, '  "seriesCount": ', vm.toString(roundIds.length), ",\n");
        json = string.concat(json, '  "seriesLength": ', vm.toString(SERIES_LENGTH), ",\n");
        json = string.concat(json, '  "greenLengthCount": ', vm.toString(GREEN_LENGTH_COUNT), ",\n");
        json = string.concat(json, '  "changeBlockCount": ', vm.toString(_changeBlockCount()), ",\n");
        json = string.concat(json, '  "series": [\n');

        for (uint256 s = 0; s < roundIds.length; s++) {
            json = string.concat(json, s == 0 ? "    {\n" : ",\n    {\n");
            json = string.concat(json, '      "roundId": ', vm.toString(uint256(roundIds[s])), ",\n");
            json = string.concat(json, '      "startBlock": ', vm.toString(uint256(startBlocks[s])), ",\n");
            json = string.concat(json, '      "firstBlock": ', vm.toString(firstBlocks[s]), ",\n");
            json = string.concat(json, '      "pattern": "', _pattern(game, roundIds[s], startBlocks[s], firstBlocks[s]), '",\n');
            json = string.concat(json, '      "greenLengths": [', _greenLengths(game, roundIds[s]), "],\n");
            json = string.concat(json, '      "changeBlocks": [', _changeBlocks(game, roundIds[s], startBlocks[s], firstBlocks[s]), "]\n");
            json = string.concat(json, "    }");
        }

        json = string.concat(json, "\n  ]\n}\n");

        string memory path = string.concat(vm.projectRoot(), "/test/fixtures/light-fixture.json");
        vm.writeFile(path, json);

        console.log("Wrote light fixture to:", path);
        console.log("Series:", roundIds.length, "x blocks each:", SERIES_LENGTH);
    }

    /// @dev "G"/"R" for each of SERIES_LENGTH consecutive blocks.
    function _pattern(RedLightGreenBlock game, uint32 roundId, uint48 startBlock, uint256 firstBlock)
        internal
        pure
        returns (string memory out)
    {
        bytes memory chars = new bytes(SERIES_LENGTH);
        for (uint256 i = 0; i < SERIES_LENGTH; i++) {
            chars[i] = game.lightAt(roundId, startBlock, firstBlock + i) ? bytes1("G") : bytes1("R");
        }
        return string(chars);
    }

    function _greenLengths(RedLightGreenBlock game, uint32 roundId) internal pure returns (string memory out) {
        for (uint256 c = 0; c < GREEN_LENGTH_COUNT; c++) {
            out = string.concat(out, c == 0 ? "" : ",", vm.toString(game.greenBlocksInCycle(roundId, c)));
        }
    }

    /// @dev Sampled every 37 blocks: a prime stride, so samples do not land on cycle boundaries.
    function _changeBlocks(RedLightGreenBlock game, uint32 roundId, uint48 startBlock, uint256 firstBlock)
        internal
        pure
        returns (string memory out)
    {
        bool first = true;
        for (uint256 i = 0; i < SERIES_LENGTH; i += 37) {
            uint256 b = firstBlock + i;
            out = string.concat(
                out,
                first ? "" : ",",
                "[",
                vm.toString(b),
                ",",
                vm.toString(game.nextLightChangeAfter(roundId, startBlock, b)),
                "]"
            );
            first = false;
        }
    }
}
