// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import "../contracts/RedLightGreenBlock.sol";

/**
 * @notice Deploy script for RedLightGreenBlock.
 *
 * @dev The contract takes no constructor arguments and has no owner, so there is nothing to
 *      configure and nothing to get wrong at deploy time. That is the point: there is no admin
 *      key to lose and no privileged address baked in.
 *
 *      The first round is NOT started here. `startRound()` is permissionless, so the room starts
 *      the round itself when the demo begins — starting it from the deploy script would mean the
 *      round's schedule was anchored to whenever the deploy happened to land, and most of it
 *      would be wasted before anybody joined.
 *
 * Example:
 *   yarn deploy --file DeployRedLightGreenBlock.s.sol --network monad_testnet
 */
contract DeployRedLightGreenBlock is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        RedLightGreenBlock game = new RedLightGreenBlock();

        console.log("RedLightGreenBlock deployed at:", address(game));
        console.log("  track length     :", game.TRACK_LENGTH());
        console.log("  cycle length     :", game.CYCLE_LENGTH_BLOCKS(), "blocks");
        console.log("  green per cycle  :", game.MIN_GREEN_BLOCKS(), "to", game.MAX_GREEN_BLOCKS());
        console.log("  round length     :", game.ROUND_LENGTH_BLOCKS(), "blocks");
        console.log("Round 1 is NOT started. Anyone can call startRound() to begin.");
    }
}
