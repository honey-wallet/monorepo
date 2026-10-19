// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {BunkModule} from "./BunkModule.sol";

/// @notice Honey-issued, operation-bound sponsorship with on-chain liability limits.
/// @dev Administrative authority controls gas funding only, never wallet execution.
///      Experimental; bundler staking/trace acceptance and operator service remain required.
contract BunkPaymaster is BasePaymaster, EIP712 {
    bytes32 public constant SPONSOR_TYPEHASH = keccak256(
        "BunkSponsorship(bytes32 operationHash,uint48 validAfter,uint48 validUntil,uint128 maxCost,uint256 nonce,uint64 epoch)"
    );
    uint256 public constant HEADER_LENGTH = 52;
    uint256 public constant GRANT_LENGTH = 352;

    struct Sponsorship {
        uint48 validAfter;
        uint48 validUntil;
        uint128 maxCost;
        uint256 nonce;
        uint64 epoch;
        bytes signature;
    }

    BunkModule public immutable module;
    uint128 public immutable maxCostPerOperation;
    address public sponsorSigner;
    uint64 public sponsorEpoch;
    uint256 public remainingBudget;
    mapping(uint256 nonce => bool) public usedNonce;

    error InvalidSponsorConfiguration();
    event SponsorChanged(address indexed signer, uint64 epoch);
    event BudgetSet(uint256 remainingBudget);
    event Sponsored(address indexed account, uint256 indexed nonce, uint256 reservedCost);

    constructor(
        IEntryPoint entryPoint_,
        BunkModule module_,
        address sponsorSigner_,
        uint128 maxCostPerOperation_,
        address treasuryAdmin
    ) BasePaymaster(entryPoint_) EIP712("HoneyBunkSponsorship", "1") {
        if (
            address(module_).code.length == 0 || module_.entryPoint() != address(entryPoint_)
                || sponsorSigner_ == address(0) || maxCostPerOperation_ == 0
                || treasuryAdmin == address(0)
        ) revert InvalidSponsorConfiguration();
        module = module_;
        sponsorSigner = sponsorSigner_;
        maxCostPerOperation = maxCostPerOperation_;
        _transferOwnership(treasuryAdmin);
    }

    function setSponsorSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidSponsorConfiguration();
        sponsorSigner = signer;
        sponsorEpoch += 1;
        emit SponsorChanged(signer, sponsorEpoch);
    }

    /// @dev Explicit treasury allocation. Decrements by worst-case liability, without refunds.
    ///      This conservative budget is independent from the actual EntryPoint ETH deposit.
    function setBudget(uint256 budget) external onlyOwner {
        remainingBudget = budget;
        emit BudgetSet(budget);
    }

    function sponsorshipDigest(PackedUserOperation calldata op, Sponsorship memory sponsorship)
        public
        view
        returns (bytes32)
    {
        if (op.paymasterAndData.length < HEADER_LENGTH) revert InvalidSponsorConfiguration();
        // Exclude sponsor/owner signatures to avoid a circular signature dependency.
        // Bind every other operation field, including the paymaster address and gas limits.
        bytes32 operationHash = keccak256(
            abi.encode(
                address(entryPoint),
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(op.paymasterAndData[:HEADER_LENGTH])
            )
        );
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SPONSOR_TYPEHASH,
                    operationHash,
                    sponsorship.validAfter,
                    sponsorship.validUntil,
                    sponsorship.maxCost,
                    sponsorship.nonce,
                    sponsorship.epoch
                )
            )
        );
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (op.paymasterAndData.length != HEADER_LENGTH + GRANT_LENGTH) return ("", 1);
        Sponsorship memory sponsorship =
            abi.decode(op.paymasterAndData[HEADER_LENGTH:], (Sponsorship));
        (bytes32 commitment,) = module.ownerState(op.sender);
        if (
            commitment == bytes32(0) || usedNonce[sponsorship.nonce]
                || sponsorship.epoch != sponsorEpoch
                || sponsorship.validUntil <= sponsorship.validAfter
                || sponsorship.validUntil - sponsorship.validAfter > 1 hours
                || maxCost > sponsorship.maxCost || maxCost > maxCostPerOperation
                || maxCost > remainingBudget
        ) return ("", 1);

        (address signer, ECDSA.RecoverError error,) =
            ECDSA.tryRecover(sponsorshipDigest(op, sponsorship), sponsorship.signature);
        if (error != ECDSA.RecoverError.NoError || signer != sponsorSigner) return ("", 1);

        usedNonce[sponsorship.nonce] = true;
        remainingBudget -= maxCost;
        emit Sponsored(op.sender, sponsorship.nonce, maxCost);
        // Empty context deliberately avoids a postOp dependency that could revert user calls.
        return ("", uint256(sponsorship.validUntil) << 160 | uint256(sponsorship.validAfter) << 208);
    }
}
