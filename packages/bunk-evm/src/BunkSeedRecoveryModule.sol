// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {Safe} from "safe/Safe.sol";
import {Enum} from "safe/common/Enum.sol";

interface IBunkSeedRecoveryBootstrap {
    function consumeBootstrap(address account)
        external
        returns (bytes32 commitment, bytes32 recoveryCommitment);
}

/// @notice Version 3 candidate: independent seed recovery into a fresh owner-key generation.
/// @dev Not audited or released. Requires versioned client/journal/backup integration before activation.
contract BunkSeedRecoveryModule is IAccount, IAccountExecute, EIP712 {
    bytes32 public constant CERTIFICATE_TYPEHASH = keccak256(
        "BunkOwnerIntent(address entryPoint,address account,uint256 nonce,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,uint128 maxGasCost,address paymaster,uint32 ownerIndex,bytes32 nextCommitment,bytes32 envelopeRoot,uint48 validAfter,uint48 executeUntil)"
    );

    struct Certificate {
        address entryPoint;
        address account;
        uint256 nonce;
        bytes32 callDataHash;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        uint128 maxGasCost;
        address paymaster;
        uint32 ownerIndex;
        bytes32 nextCommitment;
        bytes32 envelopeRoot;
        uint48 validAfter;
        uint48 executeUntil;
    }

    struct Authorization {
        Certificate certificate;
        uint8 attempt;
        bytes32[] proof;
        bytes ownerSignature;
        bytes envelopeSignature;
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct Reservation {
        bool authorized;
        uint48 executeUntil;
        uint32 epoch;
    }

    struct RecoveryState {
        bytes32 commitment;
        uint32 epoch;
    }
    bytes32 public constant RECOVERY_TYPEHASH = keccak256(
        "BunkSeedRecovery(address entryPoint,address account,uint32 epoch,bytes32 nextOwnerCommitment,bytes32 nextRecoveryCommitment)"
    );
    mapping(address account => RecoveryState) public recoveryState;
    event SeedRecovered(
        address indexed account,
        uint32 indexed epoch,
        bytes32 ownerCommitment,
        bytes32 recoveryCommitment
    );
    event RecoveryCancelledAction(address indexed account, bytes32 indexed userOpHash);
    error InvalidRecovery();
    uint32 public constant MAX_OWNER_INDEX = 0x7fffffff;
    uint256 public constant MAX_CALLDATA = 6144;
    uint256 public constant MAX_OPERATION_BYTES = 8192;
    address public immutable entryPoint;
    address public immutable factory;

    struct OwnerState {
        bytes32 commitment;
        uint32 index;
    }
    mapping(address account => OwnerState) public ownerState;
    // Innermost account key preserves sender-associated slots for canonical bundlers.
    mapping(bytes32 commitment => mapping(address account => bool)) private consumedCommitments;
    mapping(bytes32 userOpHash => mapping(address account => Reservation)) private reservations;

    event Initialized(address indexed account, bytes32 commitment);
    event OwnerConsumed(
        address indexed account,
        bytes32 indexed userOpHash,
        bytes32 indexed intentHash,
        uint32 consumedIndex,
        bytes32 nextCommitment
    );
    event ActionExecuted(address indexed account, bytes32 indexed userOpHash);
    event ExpiredActionSkipped(address indexed account, bytes32 indexed userOpHash);

    error InvalidOperation();
    error UnauthorizedCaller();
    error AlreadyInitialized();
    error PrefundFailed();
    error CallFailed(uint256 index);

    constructor(address entryPoint_, address factory_) EIP712("HoneyBunkOwner", "3") {
        if (entryPoint_.code.length == 0 || factory_ == address(0)) revert UnauthorizedCaller();
        entryPoint = entryPoint_;
        factory = factory_;
    }

    function initialize() external {
        if (ownerState[msg.sender].commitment != bytes32(0)) revert AlreadyInitialized();
        (bytes32 commitment, bytes32 recoveryCommitment) =
            IBunkSeedRecoveryBootstrap(factory).consumeBootstrap(msg.sender);
        if (
            commitment == bytes32(0) || recoveryCommitment == bytes32(0)
                || commitment == recoveryCommitment
        ) revert UnauthorizedCaller();
        ownerState[msg.sender] = OwnerState(commitment, 0);
        recoveryState[msg.sender] = RecoveryState(recoveryCommitment, 0);
        emit Initialized(msg.sender, commitment);
    }

    function seedRecoveryDigest(
        address account,
        uint32 epoch,
        bytes32 nextOwnerCommitment,
        bytes32 nextRecoveryCommitment
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RECOVERY_TYPEHASH,
                    entryPoint,
                    account,
                    epoch,
                    nextOwnerCommitment,
                    nextRecoveryCommitment
                )
            )
        );
    }

    /// @notice A caller-funded relay of the seed holder's exact generation-reset certificate.
    /// @dev No Safe calls, fee reimbursement, bootstrap reset, or Honey administrator authority.
    /// The certificate deliberately excludes current owner index, nonce and pending intent:
    /// it remains identical while ordinary transactions advance within this recovery epoch.
    function recoverFromSeed(
        address account,
        uint32 epoch,
        bytes32 nextOwnerCommitment,
        bytes32 nextRecoveryCommitment,
        bytes calldata signature
    ) external {
        OwnerState storage owner = ownerState[account];
        RecoveryState storage recovery = recoveryState[account];
        if (
            owner.commitment == bytes32(0) || recovery.commitment == bytes32(0)
                || epoch != recovery.epoch || epoch == MAX_OWNER_INDEX
                || nextOwnerCommitment == bytes32(0) || nextRecoveryCommitment == bytes32(0)
                || nextOwnerCommitment == nextRecoveryCommitment
                || _usedForEitherRole(account, nextOwnerCommitment)
                || _usedForEitherRole(account, nextRecoveryCommitment)
        ) revert InvalidRecovery();
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(
            seedRecoveryDigest(account, epoch, nextOwnerCommitment, nextRecoveryCommitment),
            signature
        );
        if (
            error != ECDSA.RecoverError.NoError
                || keccak256(abi.encodePacked(signer)) != recovery.commitment
        ) revert InvalidRecovery();
        consumedCommitments[owner.commitment][account] = true;
        consumedCommitments[recovery.commitment][account] = true;
        owner.commitment = nextOwnerCommitment;
        owner.index = 0;
        recovery.commitment = nextRecoveryCommitment;
        recovery.epoch = epoch + 1;
        emit SeedRecovered(account, epoch + 1, nextOwnerCommitment, nextRecoveryCommitment);
    }

    function _usedForEitherRole(address account, bytes32 commitment) private view returns (bool) {
        return commitment == ownerState[account].commitment
            || commitment == recoveryState[account].commitment
            || consumedCommitments[commitment][account];
    }

    function usedCommitment(address account, bytes32 commitment) external view returns (bool) {
        return commitment != bytes32(0)
            && (ownerState[account].commitment == commitment
                || consumedCommitments[commitment][account]);
    }

    function reservation(address account, bytes32 opHash)
        external
        view
        returns (bool authorized, uint48 executeUntil)
    {
        Reservation memory r = reservations[opHash][account];
        return (r.authorized, r.executeUntil);
    }

    function certificateDigest(Certificate memory certificate) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CERTIFICATE_TYPEHASH, certificate)));
    }

    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash, uint256 missingFunds)
        external
        returns (uint256)
    {
        _requireEntryPoint(op.sender);
        // Canonical certificate + 8-node proof + two 65-byte signatures totals 1120 bytes.
        // abi.encode(op) has 448 bytes of fixed overhead plus padded dynamic fields;
        // measuring lengths avoids allocating/copying the complete operation during validation.
        if (
            op.signature.length != 1120 || op.initCode.length > 1024
                || 448 + ((op.initCode.length + 31) & ~uint256(31))
                        + ((op.callData.length + 31) & ~uint256(31))
                        + ((op.paymasterAndData.length + 31) & ~uint256(31)) + op.signature.length
                    > MAX_OPERATION_BYTES
        ) revert InvalidOperation();
        Authorization memory a = abi.decode(op.signature, (Authorization));
        if (keccak256(abi.encode(a)) != keccak256(op.signature)) revert InvalidOperation();
        Certificate memory c = a.certificate;
        OwnerState storage state = ownerState[msg.sender];
        bool recovery = a.attempt == 255;
        if (recovery) {
            Call[] memory empty = new Call[](0);
            if (
                op.initCode.length != 0 || op.paymasterAndData.length != 0
                    || keccak256(op.callData)
                        != keccak256(
                            abi.encodePacked(
                                IAccountExecute.executeUserOp.selector, abi.encode(empty)
                            )
                        )
            ) revert InvalidOperation();
        } else {
            _calls(op.callData);
        }
        if (
            c.entryPoint != entryPoint || c.account != msg.sender || c.nonce != op.nonce
                || c.nonce > type(uint64).max
                || (!recovery && c.callDataHash != keccak256(op.callData))
                || c.accountGasLimits != op.accountGasLimits
                || c.preVerificationGas != op.preVerificationGas || c.maxGasCost == 0
                || c.ownerIndex != state.index || state.index == MAX_OWNER_INDEX
                || c.nextCommitment == bytes32(0) || c.nextCommitment == state.commitment
                || _usedForEitherRole(msg.sender, c.nextCommitment) || c.envelopeRoot == bytes32(0)
                || a.proof.length != 8 || c.executeUntil <= c.validAfter
                || c.executeUntil - c.validAfter > 1 hours || c.executeUntil == type(uint48).max
        ) return 1;
        _checkGas(op, c);
        if (recovery) {
            uint256 totalGas = uint128(bytes16(c.accountGasLimits))
                + uint256(uint128(uint256(c.accountGasLimits))) + c.preVerificationGas;
            uint256 fee = c.maxGasCost / totalGas;
            if (op.gasFees != bytes32(fee << 128 | fee)) revert InvalidOperation();
        }
        bytes32 digest = certificateDigest(c);
        (address owner, ECDSA.RecoverError ownerError,) = ECDSA.tryRecover(digest, a.ownerSignature);
        (address envelope, ECDSA.RecoverError envelopeError,) =
            ECDSA.tryRecover(opHash, a.envelopeSignature);
        if (
            ownerError != ECDSA.RecoverError.NoError
                || keccak256(abi.encodePacked(owner)) != state.commitment
                || envelopeError != ECDSA.RecoverError.NoError
                || !MerkleProof.verify(
                    a.proof,
                    c.envelopeRoot,
                    keccak256(abi.encodePacked(keccak256(abi.encode(a.attempt, envelope))))
                ) || envelope == owner
        ) return 1;
        // Current commitment is already authoritative; persist its tombstone only when consumed.
        // This avoids a second new storage slot during counterfactual creation while preserving
        // rejection of both the current commitment and every previously consumed commitment.
        consumedCommitments[state.commitment][msg.sender] = true;
        state.commitment = c.nextCommitment;
        state.index++;
        reservations[opHash][msg.sender] =
            Reservation(true, c.executeUntil, recoveryState[msg.sender].epoch);
        emit OwnerConsumed(msg.sender, opHash, digest, c.ownerIndex, c.nextCommitment);
        if (missingFunds != 0) {
            if (!Safe(payable(msg.sender))
                    .execTransactionFromModule(entryPoint, missingFunds, "", Enum.Operation.Call)) revert PrefundFailed();
        }
        // No TIMESTAMP opcode during validation. Expiry applies to the ACTION below.
        // After the action expires, the SAME certificate still permits a bounded rotation.
        return uint256(recovery ? c.executeUntil + 1 : c.validAfter) << 208;
    }

    function _checkGas(PackedUserOperation calldata op, Certificate memory c) private pure {
        uint256 verificationGas = uint128(bytes16(op.accountGasLimits));
        uint256 callGas = uint128(uint256(op.accountGasLimits));
        uint256 priority = uint128(bytes16(op.gasFees));
        uint256 maxFee = uint128(uint256(op.gasFees));
        if (
            verificationGas == 0 || verificationGas > 500_000 || callGas == 0
                || callGas > type(uint120).max || op.preVerificationGas == 0
                || op.preVerificationGas > type(uint120).max || maxFee == 0
                || maxFee > type(uint120).max || priority > maxFee
        ) revert InvalidOperation();
        uint256 totalGas = verificationGas + callGas + op.preVerificationGas;
        if (op.paymasterAndData.length != 0) {
            // Version 2 profile matches the existing Honey empty-context paymaster.
            if (
                op.paymasterAndData.length != 404 || c.paymaster == address(0)
                    || address(bytes20(op.paymasterAndData[:20])) != c.paymaster
                    || uint128(bytes16(op.paymasterAndData[20:36])) != 200_000
                    || uint128(bytes16(op.paymasterAndData[36:52])) != 0
            ) revert InvalidOperation();
            totalGas += 200_000;
        }
        // Signed ceiling also explicitly authorizes a self-funded fallback.
        if (totalGas * maxFee > c.maxGasCost) revert InvalidOperation();
    }

    function executeUserOp(PackedUserOperation calldata op, bytes32 opHash) external {
        _requireEntryPoint(op.sender);
        Reservation memory approved = reservations[opHash][msg.sender];
        if (!approved.authorized) revert InvalidOperation();
        delete reservations[opHash][msg.sender];
        // handleOps validates every operation before executing any of them. A recovery
        // relayed by an earlier execution must also cancel already-validated old calls.
        if (approved.epoch != recoveryState[msg.sender].epoch) {
            emit RecoveryCancelledAction(msg.sender, opHash);
            return;
        }
        if (block.timestamp > approved.executeUntil) {
            emit ExpiredActionSkipped(msg.sender, opHash);
            return;
        }
        Call[] memory calls = _calls(op.callData);
        for (uint256 i; i < calls.length; ++i) {
            if (!Safe(payable(msg.sender))
                    .execTransactionFromModule(
                        calls[i].target, calls[i].value, calls[i].data, Enum.Operation.Call
                    )) revert CallFailed(i);
            // Recovery can be relayed by the called contract. Preserve that reset,
            // but do not execute the remaining calls under the superseded generation.
            if (approved.epoch != recoveryState[msg.sender].epoch) {
                emit RecoveryCancelledAction(msg.sender, opHash);
                return;
            }
        }
        emit ActionExecuted(msg.sender, opHash);
    }

    function _requireEntryPoint(address sender) private view {
        address originalCaller;
        assembly ("memory-safe") {
            originalCaller := shr(96, calldataload(sub(calldatasize(), 20)))
        }
        if (
            sender != msg.sender || ownerState[msg.sender].commitment == bytes32(0)
                || originalCaller != entryPoint
        ) revert UnauthorizedCaller();
    }

    function _calls(bytes calldata encoded) private view returns (Call[] memory calls) {
        if (
            encoded.length < 4 || encoded.length > MAX_CALLDATA
                || bytes4(encoded[:4]) != IAccountExecute.executeUserOp.selector
        ) revert InvalidOperation();
        calls = abi.decode(encoded[4:], (Call[]));
        if (keccak256(abi.encode(calls)) != keccak256(encoded[4:])) revert InvalidOperation();
        if (calls.length == 0 || calls.length > 16) revert InvalidOperation();
        for (uint256 i; i < calls.length; ++i) {
            if (
                calls[i].target == address(0) || calls[i].target == msg.sender
                    || calls[i].target == address(this) || calls[i].target == factory
                    || (calls[i].target == entryPoint && !_depositWithdrawal(calls[i], msg.sender))
            ) revert InvalidOperation();
        }
    }

    /// @dev The sole EntryPoint CALL exception returns this Safe's gas deposit to itself.
    ///      No other EntryPoint method, recipient, ETH value or noncanonical address is allowed.
    function _depositWithdrawal(Call memory operation, address account)
        private
        pure
        returns (bool)
    {
        if (operation.value != 0 || operation.data.length != 68) return false;
        bytes memory data = operation.data;
        bytes4 selector;
        uint256 recipientWord;
        assembly ("memory-safe") {
            selector := mload(add(data, 32))
            recipientWord := mload(add(data, 36))
        }
        return
            selector == IStakeManager.withdrawTo.selector
                && recipientWord == uint256(uint160(account));
    }
}

