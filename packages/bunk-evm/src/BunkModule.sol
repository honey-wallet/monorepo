// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Safe} from "safe/Safe.sol";
import {Enum} from "safe/common/Enum.sol";

interface IBunkBootstrap {
    function consumeBootstrap(address account) external returns (bytes32 commitment);
}

/// @notice Experimental Safe 1.4.1 / EntryPoint 0.7 rotation module and fallback handler.
/// @dev Not audited or deployed. Uses a separate first-deployment factory; no admin/reset key.
///      Only the trusted EntryPoint, forwarded by a registered Safe, may validate or execute.
contract BunkModule is IAccount, IAccountExecute, EIP712 {
    uint32 public constant MAX_OWNER_INDEX = 0x7fffffff;
    uint256 public constant MAX_CALLS = 16;
    // Leave room for the owner/sponsor signatures and ABI overhead in an 8 KiB UserOperation.
    uint256 public constant MAX_CALLDATA = 6_144;
    bytes32 public constant OWNER_TYPEHASH = keccak256(
        "BunkOwnerOperation(bytes32 userOpHash,uint32 ownerIndex,bytes32 nextCommitment,uint48 validAfter,uint48 validUntil)"
    );

    struct OwnerState {
        bytes32 commitment;
        uint32 index;
    }

    struct Authorization {
        uint32 ownerIndex;
        bytes32 nextCommitment;
        uint48 validAfter;
        uint48 validUntil;
        bytes signature;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable entryPoint;
    address public immutable factory;
    mapping(address account => OwnerState) public ownerState;
    // Account is the innermost key so the final slot is keccak(account || x),
    // associated with the sender under ERC-7562 even though stored in this module.
    mapping(bytes32 commitment => mapping(address account => bool)) private usedCommitments;
    mapping(bytes32 userOpHash => mapping(address account => bool)) private authorizedOperations;

    error UnauthorizedCaller();
    error AlreadyInitialized();
    error InvalidOperation();
    error PrefundFailed();
    error CallFailed(uint256 callIndex);

    event Initialized(address indexed account, bytes32 commitment);
    event OwnerConsumed(
        address indexed account,
        bytes32 indexed userOpHash,
        uint32 consumedIndex,
        bytes32 nextCommitment
    );
    event Executed(address indexed account, bytes32 indexed userOpHash);

    constructor(address entryPoint_, address factory_) EIP712("HoneyBunkOwner", "1") {
        if (entryPoint_.code.length == 0 || factory_ == address(0)) revert UnauthorizedCaller();
        entryPoint = entryPoint_;
        factory = factory_;
    }

    /// @dev Called by the Safe during atomic setup. Factory record binds the predicted account.
    function initialize() external {
        if (ownerState[msg.sender].commitment != bytes32(0)) revert AlreadyInitialized();
        bytes32 commitment = IBunkBootstrap(factory).consumeBootstrap(msg.sender);
        if (commitment == bytes32(0)) revert UnauthorizedCaller();
        ownerState[msg.sender] = OwnerState(commitment, 0);
        usedCommitments[commitment][msg.sender] = true;
        emit Initialized(msg.sender, commitment);
    }

    function usedCommitment(address account, bytes32 commitment) external view returns (bool) {
        return usedCommitments[commitment][account];
    }

    function authorizedOperation(address account, bytes32 userOpHash) external view returns (bool) {
        return authorizedOperations[userOpHash][account];
    }

    function ownerDigest(bytes32 userOpHash, Authorization memory authorization)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OWNER_TYPEHASH,
                    userOpHash,
                    authorization.ownerIndex,
                    authorization.nextCommitment,
                    authorization.validAfter,
                    authorization.validUntil
                )
            )
        );
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData) {
        _requireEntryPoint(userOp.sender);
        _validateCalls(userOp.callData, msg.sender);
        // ABI-encoded dynamic struct with one 65-byte signature (320 padded bytes).
        if (userOp.signature.length != 320) return 1;
        Authorization memory authorization = abi.decode(userOp.signature, (Authorization));
        OwnerState storage state = ownerState[msg.sender];
        if (
            authorization.ownerIndex != state.index || state.index == MAX_OWNER_INDEX
                || authorization.nextCommitment == bytes32(0)
                || usedCommitments[authorization.nextCommitment][msg.sender]
                || authorization.validUntil <= authorization.validAfter
                || authorization.validUntil - authorization.validAfter > 1 hours
        ) return 1;

        (address signer, ECDSA.RecoverError error,) =
            ECDSA.tryRecover(ownerDigest(userOpHash, authorization), authorization.signature);
        if (
            error != ECDSA.RecoverError.NoError
                || keccak256(abi.encodePacked(signer)) != state.commitment
        ) return 1;

        // EntryPoint retains validation writes if only the later execution frame fails.
        // A rejected bundle/time window/prefund reverts these writes with the whole handleOps.
        state.commitment = authorization.nextCommitment;
        state.index += 1;
        usedCommitments[authorization.nextCommitment][msg.sender] = true;
        authorizedOperations[userOpHash][msg.sender] = true;
        emit OwnerConsumed(
            msg.sender, userOpHash, authorization.ownerIndex, authorization.nextCommitment
        );

        if (
            missingAccountFunds != 0
                && !Safe(payable(msg.sender))
                    .execTransactionFromModule(
                        entryPoint, missingAccountFunds, "", Enum.Operation.Call
                    )
        ) revert PrefundFailed();

        // Do not read TIMESTAMP in validation; EntryPoint enforces the signed validity window.
        return uint256(authorization.validUntil) << 160 | uint256(authorization.validAfter) << 208;
    }

    /// @dev EntryPoint 0.7 recognizes this selector and supplies the full op + its hash.
    ///      Original userOp.callData is selector || abi.encode(Call[]).
    function executeUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external {
        _requireEntryPoint(userOp.sender);
        if (!authorizedOperations[userOpHash][msg.sender]) revert InvalidOperation();
        delete authorizedOperations[userOpHash][msg.sender];
        Call[] memory calls = _validateCalls(userOp.callData, msg.sender);
        for (uint256 i = 0; i < calls.length; ++i) {
            Call memory operation = calls[i];
            if (!Safe(payable(msg.sender))
                    .execTransactionFromModule(
                        operation.target, operation.value, operation.data, Enum.Operation.Call
                    )) revert CallFailed(i);
        }
        emit Executed(msg.sender, userOpHash);
    }

    function _requireEntryPoint(address sender) private view {
        // Safe appends the original caller to fallback calldata. User-supplied suffixes
        // cannot replace this final address. Direct calls do not come from registered Safes.
        address originalCaller;
        assembly ("memory-safe") {
            originalCaller := shr(96, calldataload(sub(calldatasize(), 20)))
        }
        if (
            sender != msg.sender || ownerState[msg.sender].commitment == bytes32(0)
                || originalCaller != entryPoint
        ) revert UnauthorizedCaller();
    }

    function _validateCalls(bytes calldata encoded, address account)
        private
        view
        returns (Call[] memory calls)
    {
        if (
            encoded.length < 4 || encoded.length > MAX_CALLDATA
                || bytes4(encoded[:4]) != IAccountExecute.executeUserOp.selector
        ) revert InvalidOperation();
        calls = abi.decode(encoded[4:], (Call[]));
        if (calls.length == 0 || calls.length > MAX_CALLS) revert InvalidOperation();
        for (uint256 i = 0; i < calls.length; ++i) {
            address target = calls[i].target;
            if (
                target == address(0) || target == account || target == address(this)
                    || target == factory || target == entryPoint
            ) revert InvalidOperation();
        }
    }
}
