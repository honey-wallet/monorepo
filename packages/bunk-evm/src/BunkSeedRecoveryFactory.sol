// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {Safe} from "safe/Safe.sol";
import {SafeProxyFactory} from "safe/proxies/SafeProxyFactory.sol";
import {BunkSeedRecoveryModule, IBunkSeedRecoveryBootstrap} from "./BunkSeedRecoveryModule.sol";
import {BunkSeedRecoverySetup} from "./BunkSeedRecoverySetup.sol";

/// @notice Version 3 atomic, deployment-only bootstrap. No privileged account mutation after initialization.
/// @dev Experimental: complete independent review and bundler/recovery acceptance before use.
contract BunkSeedRecoveryFactory is EIP712, ReentrancyGuard, Ownable, IBunkSeedRecoveryBootstrap {
    bytes32 public constant DEPLOY_TYPEHASH = keccak256(
        "BunkDeployment(address identity,uint32 accountIndex,address account,bytes32 commitment,bytes32 recoveryCommitment,bytes32 configHash)"
    );
    bytes32 private constant FALLBACK_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;
    bytes32 private constant GUARD_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    Safe public immutable singleton;
    SafeProxyFactory public immutable proxyFactory;
    BunkSeedRecoveryModule public immutable module;
    BunkSeedRecoverySetup public immutable helper;
    bytes32 public immutable configHash;

    // Bootstrap data exists only while this atomic deployment is executing. Two
    // persistent slots would exceed sponsored creation's 500k verification budget.
    bytes32 private constant BOOTSTRAP_SLOT = keccak256("honey.bunk.v3.bootstrap");

    error InvalidDeployment();
    error InvalidBootstrapSignature();
    error InvalidConfiguration();
    error UnauthorizedBootstrap();

    event AccountDeployed(
        address indexed account,
        address indexed identity,
        uint32 accountIndex,
        bytes32 commitment,
        bytes32 recoveryCommitment,
        bytes32 configHash
    );

    constructor(
        Safe singleton_,
        SafeProxyFactory proxyFactory_,
        address entryPoint,
        address stakeAdmin
    ) EIP712("HoneyBunkDeployment", "3") Ownable(stakeAdmin) {
        if (
            address(singleton_).code.length == 0 || address(proxyFactory_).code.length == 0
                || keccak256(bytes(singleton_.VERSION())) != keccak256("1.4.1")
        ) revert InvalidConfiguration();
        singleton = singleton_;
        proxyFactory = proxyFactory_;
        module = new BunkSeedRecoveryModule(entryPoint, address(this));
        helper = new BunkSeedRecoverySetup(module);
        configHash = keccak256(
            abi.encode(
                address(singleton_),
                address(singleton_).codehash,
                address(proxyFactory_),
                address(proxyFactory_).codehash,
                entryPoint,
                entryPoint.codehash,
                address(module),
                address(module).codehash,
                address(helper),
                address(helper).codehash
            )
        );
    }

    /// @notice Treasury-only staking controls. None can change an account or bootstrap record.
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        IEntryPoint(module.entryPoint()).addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        IEntryPoint(module.entryPoint()).unlockStake();
    }

    function withdrawStake(address payable recipient) external onlyOwner {
        IEntryPoint(module.entryPoint()).withdrawStake(recipient);
    }

    function initializer() public view returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = address(module);
        return abi.encodeCall(
            Safe.setup,
            (
                owners,
                1,
                address(helper),
                abi.encodeCall(BunkSeedRecoverySetup.setup, ()),
                address(module),
                address(0),
                0,
                payable(address(0))
            )
        );
    }

    function saltNonce(address identity, uint32 accountIndex) public pure returns (uint256) {
        return uint256(keccak256(abi.encode("HoneyBunkAccountV3", identity, accountIndex)));
    }

    function predictAccount(address identity, uint32 accountIndex) public view returns (address) {
        bytes32 salt = keccak256(
            abi.encodePacked(keccak256(initializer()), saltNonce(identity, accountIndex))
        );
        bytes32 initHash = keccak256(
            abi.encodePacked(proxyFactory.proxyCreationCode(), uint256(uint160(address(singleton))))
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(proxyFactory), salt, initHash))
                )
            )
        );
    }

    /// @notice Permanent certificate for exactly one initial configuration, not spending authority.
    function deploymentDigest(
        address identity,
        uint32 accountIndex,
        bytes32 commitment,
        bytes32 recoveryCommitment
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DEPLOY_TYPEHASH,
                    identity,
                    accountIndex,
                    predictAccount(identity, accountIndex),
                    commitment,
                    recoveryCommitment,
                    configHash
                )
            )
        );
    }

    function deploy(
        address identity,
        uint32 accountIndex,
        bytes32 commitment,
        bytes32 recoveryCommitment,
        bytes calldata signature
    ) external nonReentrant returns (address account) {
        account = predictAccount(identity, accountIndex);
        if (
            identity == address(0) || accountIndex > 0x7fffffff || commitment == bytes32(0)
                || recoveryCommitment == bytes32(0) || recoveryCommitment == commitment
                || account.code.length != 0
        ) revert InvalidDeployment();
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(
            deploymentDigest(identity, accountIndex, commitment, recoveryCommitment), signature
        );
        if (error != ECDSA.RecoverError.NoError || signer != identity) {
            revert InvalidBootstrapSignature();
        }

        _writeBootstrap(account, commitment, recoveryCommitment);
        address deployed = address(
            proxyFactory.createProxyWithNonce(
                address(singleton), initializer(), saltNonce(identity, accountIndex)
            )
        );
        (bytes32 pendingOwner, bytes32 pendingRecovery) = _readBootstrap(account);
        if (deployed != account || pendingOwner != bytes32(0) || pendingRecovery != bytes32(0)) {
            revert InvalidConfiguration();
        }
        _assertConfiguration(account, commitment, recoveryCommitment);
        emit AccountDeployed(
            account, identity, accountIndex, commitment, recoveryCommitment, configHash
        );
    }

    function consumeBootstrap(address account)
        external
        returns (bytes32 commitment, bytes32 recoveryCommitment)
    {
        if (msg.sender != address(module)) revert UnauthorizedBootstrap();
        (commitment, recoveryCommitment) = _readBootstrap(account);
        if (commitment == bytes32(0) || recoveryCommitment == bytes32(0)) {
            revert UnauthorizedBootstrap();
        }
        _writeBootstrap(account, bytes32(0), bytes32(0));
    }

    function _writeBootstrap(address account, bytes32 owner, bytes32 recovery) private {
        bytes32 slot = keccak256(abi.encode(account, BOOTSTRAP_SLOT));
        assembly ("memory-safe") {
            tstore(slot, owner)
            tstore(add(slot, 1), recovery)
        }
    }

    function _readBootstrap(address account)
        private
        view
        returns (bytes32 owner, bytes32 recovery)
    {
        bytes32 slot = keccak256(abi.encode(account, BOOTSTRAP_SLOT));
        assembly ("memory-safe") {
            owner := tload(slot)
            recovery := tload(add(slot, 1))
        }
    }

    function _assertConfiguration(address account, bytes32 commitment, bytes32 recoveryCommitment)
        private
        view
    {
        Safe safe = Safe(payable(account));
        address[] memory owners = safe.getOwners();
        (address[] memory modules, address next) = safe.getModulesPaginated(address(1), 2);
        (bytes32 storedCommitment, uint32 index) = module.ownerState(account);
        (bytes32 storedRecovery, uint32 epoch) = module.recoveryState(account);
        if (
            owners.length != 1 || owners[0] != address(module) || safe.getThreshold() != 1
                || modules.length != 1 || modules[0] != address(module) || next != address(1)
                || abi.decode(safe.getStorageAt(uint256(FALLBACK_SLOT), 1), (address))
                    != address(module)
                || abi.decode(safe.getStorageAt(uint256(GUARD_SLOT), 1), (address)) != address(0)
                || abi.decode(safe.getStorageAt(0, 1), (address)) != address(singleton)
                || storedCommitment != commitment || index != 0
                || storedRecovery != recoveryCommitment || epoch != 0
        ) revert InvalidConfiguration();
    }
}
