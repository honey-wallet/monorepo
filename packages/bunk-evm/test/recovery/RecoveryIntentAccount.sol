// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

/// @notice TEST-ONLY recovery experiment. Not a Safe module or a release deployment.
/// @dev Proves scoped, one-time envelope signing without reusing the rotating owner.
contract RecoveryIntentAccount is IAccount, IAccountExecute, EIP712 {
    bytes32 public constant CERTIFICATE_TYPEHASH = keccak256(
        "RecoveryCertificate(address entryPoint,address account,uint256 nonce,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,uint128 maxGasCost,address paymaster,uint32 ownerIndex,bytes32 nextCommitment,bytes32 envelopeRoot,uint48 validAfter,uint48 executeUntil)"
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
    }
    address public immutable entryPoint;
    bytes32 public commitment;
    uint32 public ownerIndex;
    mapping(bytes32 => bool) public usedCommitment;
    mapping(bytes32 => Reservation) public reservation;

    event Consumed(bytes32 indexed userOpHash, bytes32 indexed certificateHash, uint32 index);
    event ActionExecuted(bytes32 indexed userOpHash);
    event ExpiredActionSkipped(bytes32 indexed userOpHash);

    error InvalidOperation();
    error Unauthorized();
    error PrefundFailed();
    error CallFailed(uint256 index);

    constructor(address entryPoint_, bytes32 initialCommitment)
        EIP712("HoneyBunkRecoveryExperiment", "0")
    {
        require(entryPoint_.code.length != 0 && initialCommitment != bytes32(0));
        entryPoint = entryPoint_;
        commitment = initialCommitment;
        usedCommitment[initialCommitment] = true;
    }

    receive() external payable {}

    // Compatibility with the existing real paymaster's public account-state check.
    // This does not make this test account a production BunkModule.
    function ownerState(address account) external view returns (bytes32, uint32) {
        if (account != address(this)) return (bytes32(0), 0);
        return (commitment, ownerIndex);
    }

    function certificateDigest(Certificate memory certificate) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CERTIFICATE_TYPEHASH, certificate)));
    }

    function validateUserOp(PackedUserOperation calldata op, bytes32 opHash, uint256 missingFunds)
        external
        returns (uint256)
    {
        if (msg.sender != entryPoint || op.sender != address(this)) revert Unauthorized();
        if (op.signature.length > 1536) revert InvalidOperation();
        Authorization memory a = abi.decode(op.signature, (Authorization));
        if (keccak256(abi.encode(a)) != keccak256(op.signature)) revert InvalidOperation();
        Certificate memory c = a.certificate;
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
            c.entryPoint != entryPoint || c.account != address(this) || c.nonce != op.nonce
                || c.nonce > type(uint64).max
                || (!recovery && c.callDataHash != keccak256(op.callData))
                || c.accountGasLimits != op.accountGasLimits
                || c.preVerificationGas != op.preVerificationGas || c.maxGasCost == 0
                || c.ownerIndex != ownerIndex || ownerIndex == 0x7fffffff
                || c.nextCommitment == bytes32(0) || usedCommitment[c.nextCommitment]
                || c.envelopeRoot == bytes32(0) || a.proof.length != 8
                || c.executeUntil <= c.validAfter || c.executeUntil - c.validAfter > 1 hours
                || c.executeUntil == type(uint48).max
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
                || keccak256(abi.encodePacked(owner)) != commitment
                || envelopeError != ECDSA.RecoverError.NoError
                || !MerkleProof.verify(
                    a.proof,
                    c.envelopeRoot,
                    keccak256(abi.encodePacked(keccak256(abi.encode(a.attempt, envelope))))
                ) || envelope == owner
        ) return 1;
        commitment = c.nextCommitment;
        ownerIndex++;
        usedCommitment[c.nextCommitment] = true;
        reservation[opHash] = Reservation(true, c.executeUntil);
        emit Consumed(opHash, digest, c.ownerIndex);
        if (missingFunds != 0) {
            (bool paid,) = payable(entryPoint).call{value: missingFunds}("");
            if (!paid) revert PrefundFailed();
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
            // Experimental profile matches the existing Honey empty-context paymaster.
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
        if (msg.sender != entryPoint || op.sender != address(this)) revert Unauthorized();
        Reservation memory approved = reservation[opHash];
        if (!approved.authorized) revert InvalidOperation();
        delete reservation[opHash];
        if (block.timestamp > approved.executeUntil) {
            emit ExpiredActionSkipped(opHash);
            return;
        }
        Call[] memory calls = _calls(op.callData);
        for (uint256 i; i < calls.length; ++i) {
            (bool success,) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) revert CallFailed(i);
        }
        emit ActionExecuted(opHash);
    }

    function _calls(bytes calldata encoded) private view returns (Call[] memory calls) {
        if (
            encoded.length < 4 || encoded.length > 6144
                || bytes4(encoded[:4]) != IAccountExecute.executeUserOp.selector
        ) revert InvalidOperation();
        calls = abi.decode(encoded[4:], (Call[]));
        if (keccak256(abi.encode(calls)) != keccak256(encoded[4:])) revert InvalidOperation();
        if (calls.length == 0 || calls.length > 16) revert InvalidOperation();
        for (uint256 i; i < calls.length; ++i) {
            if (
                calls[i].target == address(0) || calls[i].target == address(this)
                    || calls[i].target == entryPoint
            ) revert InvalidOperation();
        }
    }
}

/// @dev TEST-ONLY CREATE2 fixture. Production Safe/bootstrap invariants are out of scope here.
contract RecoveryIntentFactory {
    address public immutable entryPoint;

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    function predict(bytes32 commitment, bytes32 salt) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            salt,
                            keccak256(
                                abi.encodePacked(
                                    type(RecoveryIntentAccount).creationCode,
                                    abi.encode(entryPoint, commitment)
                                )
                            )
                        )
                    )
                )
            )
        );
    }

    function create(bytes32 commitment, bytes32 salt) external returns (address) {
        address account = predict(commitment, salt);
        if (account.code.length == 0) {
            account = address(new RecoveryIntentAccount{salt: salt}(entryPoint, commitment));
        }
        return account;
    }
}
