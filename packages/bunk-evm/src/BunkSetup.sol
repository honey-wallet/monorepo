// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {Safe} from "safe/Safe.sol";
import {BunkModule} from "./BunkModule.sol";

/// @dev Stateless delegatecall helper used only by the factory's exact Safe initializer.
contract BunkSetup {
    BunkModule public immutable module;
    address private immutable SELF = address(this);
    error DelegatecallRequired();

    constructor(BunkModule module_) {
        module = module_;
    }

    function setup() external {
        if (address(this) == SELF) revert DelegatecallRequired();
        Safe(payable(address(this))).enableModule(address(module));
        module.initialize();
    }
}
