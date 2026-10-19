// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @dev Negative control only: succeeds in an ordinary EVM call but violates ERC-7562.
contract BundlerNegativeAccount {
    address public immutable entryPoint;

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    function validateUserOp(PackedUserOperation calldata, bytes32, uint256)
        external
        view
        returns (uint256)
    {
        require(msg.sender == entryPoint, "wrong EntryPoint");
        return block.timestamp == 0 ? 1 : 0;
    }

    function execute() external view {
        require(msg.sender == entryPoint, "wrong EntryPoint");
    }
}
