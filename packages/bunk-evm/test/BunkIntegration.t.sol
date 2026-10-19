// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {IStakeManager} from "account-abstraction/interfaces/IStakeManager.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {Safe} from "safe/Safe.sol";
import {SafeProxyFactory} from "safe/proxies/SafeProxyFactory.sol";
import {Enum} from "safe/common/Enum.sol";
import {BunkFactory} from "../src/BunkFactory.sol";
import {BunkModule} from "../src/BunkModule.sol";
import {BunkPaymaster} from "../src/BunkPaymaster.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function deal(address account, uint256 amount) external;
    function chainId(uint256 id) external;
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function expectRevert() external;
    function expectRevert(bytes calldata data) external;
    function expectRevert(bytes4 selector) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshot) external returns (bool);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function readFile(string calldata path) external returns (string memory);
    function parseJsonBytes32(string calldata json, string calldata key) external returns (bytes32);
}

contract Target {
    uint256 public value;

    function set(uint256 value_) external payable {
        value = value_;
    }

    function fail() external pure {
        revert("target failed");
    }
}

contract BunkIntegrationTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant BOOTSTRAP = 0xb0057;
    uint256 private constant OWNER2 = 0xb002;
    uint256 private constant SPONSOR = 0x5a0050;
    // Explicitly public Foundry-only signer scalars. Never copy these into a wallet.
    uint256 private constant SYNTHETIC_OWNER0 = 0xb00b1;
    uint256 private constant SYNTHETIC_OWNER1 = 0xb00b2;
    uint256 private constant CURVE_ORDER =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    bytes32 private constant USER_OPERATION_EVENT =
        keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");

    EntryPoint private entryPoint;
    Safe private singleton;
    SafeProxyFactory private proxyFactory;
    BunkFactory private factory;
    BunkModule private module;
    Safe private account;
    Target private target;
    uint256 private owner0;
    uint256 private owner1;
    bytes32 private commitment0;
    bytes32 private commitment1;

    function setUp() public {
        vm.chainId(1);
        vm.warp(1000);
        owner0 = SYNTHETIC_OWNER0;
        owner1 = SYNTHETIC_OWNER1;
        commitment0 = _commitment(owner0);
        commitment1 = _commitment(owner1);
        entryPoint = new EntryPoint();
        singleton = new Safe();
        proxyFactory = new SafeProxyFactory();
        factory = new BunkFactory(singleton, proxyFactory, address(entryPoint), address(this));
        module = factory.module();
        target = new Target();
        account = Safe(payable(_deploy(0, commitment0)));
        vm.deal(address(account), 10 ether);
    }

    function _commitment(uint256 key) private returns (bytes32) {
        return keccak256(abi.encodePacked(vm.addr(key)));
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deploy(uint32 index, bytes32 commitment) private returns (address) {
        address identity = vm.addr(BOOTSTRAP);
        bytes memory signature =
            _sign(BOOTSTRAP, factory.deploymentDigest(identity, index, commitment));
        return factory.deploy(identity, index, commitment, signature);
    }

    function _calls(uint256 value) private view returns (bytes memory) {
        BunkModule.Call[] memory calls = new BunkModule.Call[](1);
        calls[0] = BunkModule.Call(address(target), 0, abi.encodeCall(Target.set, (value)));
        return abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
    }

    function _op(uint256 nonce, bytes memory calls)
        private
        view
        returns (PackedUserOperation memory)
    {
        return PackedUserOperation({
            sender: address(account),
            nonce: nonce,
            initCode: "",
            callData: calls,
            accountGasLimits: bytes32(uint256(500_000) << 128 | uint256(500_000)),
            preVerificationGas: 50_000,
            gasFees: bytes32(uint256(1 gwei) << 128 | uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
    }

    function _authorize(PackedUserOperation memory op, uint256 key, uint32 index, bytes32 next)
        private
        returns (PackedUserOperation memory)
    {
        BunkModule.Authorization memory authorization = BunkModule.Authorization({
            ownerIndex: index,
            nextCommitment: next,
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 1 hours),
            signature: ""
        });
        authorization.signature =
            _sign(key, module.ownerDigest(entryPoint.getUserOpHash(op), authorization));
        op.signature = abi.encode(authorization);
        require(op.signature.length == 320, "signature wire format");
        return op;
    }

    function _submit(PackedUserOperation memory op) private {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(address(0xbeef)));
    }

    function _assertOwner(bytes32 commitment, uint32 index) private view {
        (bytes32 actual, uint32 actualIndex) = module.ownerState(address(account));
        require(actual == commitment && actualIndex == index, "wrong owner state");
    }

    function _assertResult(bytes32 hash, bool expected) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(entryPoint) && logs[i].topics[0] == USER_OPERATION_EVENT
                    && logs[i].topics[1] == hash
            ) {
                (, bool success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                require(success == expected, "wrong EntryPoint receipt");
                seen = true;
            }
        }
        require(seen, "missing EntryPoint receipt");
    }

    function testDeploymentUsesPinnedVectorsAndClosesBootstrap() public {
        require(address(account) == factory.predictAccount(vm.addr(BOOTSTRAP), 0), "wrong address");
        _assertOwner(commitment0, 0);
        address[] memory owners = account.getOwners();
        require(owners.length == 1 && owners[0] == address(module), "owner bypass");
        require(account.isModuleEnabled(address(module)), "module missing");
        address identity = vm.addr(BOOTSTRAP);
        bytes memory signature =
            _sign(BOOTSTRAP, factory.deploymentDigest(identity, 0, commitment0));
        vm.expectRevert(BunkFactory.InvalidDeployment.selector);
        factory.deploy(identity, 0, commitment0, signature);
    }

    function testSameAddressAcrossChainsHasDifferentOwnerCommitments() public {
        uint256 snapshot = vm.snapshotState();
        address first = _deploy(1, commitment0);
        require(vm.revertToState(snapshot), "snapshot restore");
        vm.chainId(8453);
        bytes32 baseCommitment = keccak256("synthetic Base owner commitment");
        address second = _deploy(1, baseCommitment);
        (bytes32 current,) = module.ownerState(second);
        require(
            first == second && current == baseCommitment && current != commitment0,
            "cross-chain design failed"
        );
    }

    function testUnauthorizedFirstClaimAndReinitializationFail() public {
        bytes memory init = factory.initializer();
        uint256 salt = factory.saltNonce(vm.addr(BOOTSTRAP), 1);
        address predicted = factory.predictAccount(vm.addr(BOOTSTRAP), 1);
        vm.expectRevert();
        proxyFactory.createProxyWithNonce(address(singleton), init, salt);
        require(predicted.code.length == 0, "failed setup left code");
        vm.expectRevert(BunkFactory.UnauthorizedBootstrap.selector);
        module.initialize();
        vm.expectRevert(BunkModule.AlreadyInitialized.selector);
        BunkModule(address(account)).initialize();
        require(_deploy(1, commitment0) == predicted, "failed claim blocked real deployment");
    }

    function testBootstrapCannotCrossChainOrChangeCommitmentOrAccount() public {
        address identity = vm.addr(BOOTSTRAP);
        bytes memory sig = _sign(BOOTSTRAP, factory.deploymentDigest(identity, 1, commitment0));
        vm.expectRevert(BunkFactory.InvalidBootstrapSignature.selector);
        factory.deploy(identity, 1, commitment1, sig);
        vm.expectRevert(BunkFactory.InvalidBootstrapSignature.selector);
        factory.deploy(identity, 2, commitment0, sig);
        vm.chainId(8453);
        vm.expectRevert(BunkFactory.InvalidBootstrapSignature.selector);
        factory.deploy(identity, 1, commitment0, sig);
        vm.chainId(1);
        // A certificate is deliberately relayable later, but only for its exact configuration.
        vm.warp(1000 + 365 days);
        address deployed = factory.deploy(identity, 1, commitment0, sig);
        require(deployed == factory.predictAccount(identity, 1), "certificate address drift");
        vm.expectRevert(BunkFactory.InvalidDeployment.selector);
        factory.deploy(identity, 1, commitment0, sig);
    }

    function testRealEntryPointExecutesAndConsumesOwnerExactlyOnce() public {
        PackedUserOperation memory op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        vm.recordLogs();
        _submit(op);
        _assertResult(entryPoint.getUserOpHash(op), true);
        require(
            target.value() == 42 && entryPoint.getNonce(address(account), 0) == 1,
            "execution failed"
        );
        _assertOwner(commitment1, 1);
        require(
            !module.authorizedOperation(address(account), entryPoint.getUserOpHash(op)),
            "reservation retained"
        );
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment1, 1);
    }

    function testDownstreamRevertRollsBackActionsButNotOwnerConsumption() public {
        BunkModule.Call[] memory calls = new BunkModule.Call[](2);
        calls[0] = BunkModule.Call(address(target), 0, abi.encodeCall(Target.set, (42)));
        calls[1] = BunkModule.Call(address(target), 0, abi.encodeCall(Target.fail, ()));
        PackedUserOperation memory op = _authorize(
            _op(0, abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls))),
            owner0,
            0,
            commitment1
        );
        vm.recordLogs();
        _submit(op);
        _assertResult(entryPoint.getUserOpHash(op), false);
        require(
            target.value() == 0 && entryPoint.getNonce(address(account), 0) == 1,
            "failure atomicity"
        );
        _assertOwner(commitment1, 1);
        PackedUserOperation memory stale =
            _authorize(_op(1, _calls(7)), owner0, 0, _commitment(OWNER2));
        vm.expectRevert();
        _submit(stale);
        _submit(_authorize(_op(1, _calls(7)), owner1, 1, _commitment(OWNER2)));
        require(target.value() == 7, "next owner cannot recover");
    }

    function testExecutionOutOfGasKeepsRotationAndCanRecover() public {
        PackedUserOperation memory op = _op(0, _calls(42));
        op.accountGasLimits = bytes32(uint256(500_000) << 128 | uint256(1));
        op = _authorize(op, owner0, 0, commitment1);
        vm.recordLogs();
        _submit(op);
        _assertResult(entryPoint.getUserOpHash(op), false);
        _assertOwner(commitment1, 1);
        require(target.value() == 0, "out-of-gas target ran");
        _submit(_authorize(_op(1, _calls(9)), owner1, 1, _commitment(OWNER2)));
        require(target.value() == 9, "post-failure owner unavailable");
    }

    function testInvalidSignatureAndExpiredWindowRollBackValidation() public {
        PackedUserOperation memory op = _authorize(_op(0, _calls(42)), OWNER2, 0, commitment1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
        op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
        require(
            !module.usedCommitment(address(account), commitment1), "rejected bundle burned next key"
        );
    }

    function testNoPrefundRollsBackOwnerConsumption() public {
        PackedUserOperation memory op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        vm.deal(address(account), 0);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
    }

    function testHighSAndChangedGasOrNextKeyCannotAuthorize() public {
        PackedUserOperation memory op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        BunkModule.Authorization memory auth = abi.decode(op.signature, (BunkModule.Authorization));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(owner0, module.ownerDigest(entryPoint.getUserOpHash(op), auth));
        auth.signature =
            abi.encodePacked(r, bytes32(CURVE_ORDER - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        op.signature = abi.encode(auth);
        vm.expectRevert();
        _submit(op);
        op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        op.preVerificationGas += 1;
        vm.expectRevert();
        _submit(op);
        op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        auth = abi.decode(op.signature, (BunkModule.Authorization));
        auth.nextCommitment = _commitment(OWNER2);
        op.signature = abi.encode(auth);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
    }

    function testMultipleSequentialOwnersInOneBundle() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _authorize(_op(0, _calls(1)), owner0, 0, commitment1);
        ops[1] = _authorize(_op(1, _calls(2)), owner1, 1, _commitment(OWNER2));
        entryPoint.handleOps(ops, payable(address(0xbeef)));
        _assertOwner(_commitment(OWNER2), 2);
        require(target.value() == 2, "bundle did not execute in order");
    }

    function testConflictingOwnerInBundleRevertsWholeBundle() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _authorize(_op(0, _calls(1)), owner0, 0, commitment1);
        ops[1] = _authorize(_op(1, _calls(2)), owner0, 0, _commitment(OWNER2));
        vm.expectRevert();
        entryPoint.handleOps(ops, payable(address(0xbeef)));
        _assertOwner(commitment0, 0);
        require(target.value() == 0, "failed bundle changed target");
    }

    function testOldOwnerCommitmentsCannotBeReactivated() public {
        _submit(_authorize(_op(0, _calls(1)), owner0, 0, commitment1));
        PackedUserOperation memory op = _authorize(_op(1, _calls(2)), owner1, 1, commitment0);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment1, 1);
    }

    function testDirectAndSpoofedEntryPointExecutionFail() public {
        PackedUserOperation memory op = _authorize(_op(0, _calls(1)), owner0, 0, commitment1);
        bytes32 hash = entryPoint.getUserOpHash(op);
        vm.expectRevert(BunkModule.UnauthorizedCaller.selector);
        module.executeUserOp(op, hash);
        vm.expectRevert(BunkModule.UnauthorizedCaller.selector);
        BunkModule(address(account)).executeUserOp(op, hash);
        (bool success,) = address(account)
            .call(
                abi.encodePacked(
                    abi.encodeCall(BunkModule.executeUserOp, (op, hash)), address(entryPoint)
                )
            );
        require(!success, "forged fallback suffix executed");
        _assertOwner(commitment0, 0);
    }

    function testSelfAdministrationAndAlternateSafePathsFail() public {
        BunkModule.Call[] memory calls = new BunkModule.Call[](1);
        calls[0] = BunkModule.Call(
            address(account), 0, abi.encodeCall(account.enableModule, (address(this)))
        );
        PackedUserOperation memory op = _authorize(
            _op(0, abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls))),
            owner0,
            0,
            commitment1
        );
        vm.expectRevert();
        _submit(op);
        vm.expectRevert();
        account.enableModule(address(this));
        vm.expectRevert();
        account.execTransactionFromModule(
            address(target), 0, abi.encodeCall(Target.set, (3)), Enum.Operation.Call
        );
        bytes memory approvedHashSignature =
            abi.encodePacked(bytes32(uint256(uint160(address(module)))), bytes32(0), uint8(1));
        vm.expectRevert();
        account.execTransaction(
            address(target),
            0,
            abi.encodeCall(Target.set, (3)),
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            approvedHashSignature
        );
        _assertOwner(commitment0, 0);
    }

    function testFuzzBadOwnerCannotSpend(uint256 wrongKey) public {
        wrongKey = wrongKey % (CURVE_ORDER - 1) + 1;
        if (wrongKey == owner0) return;
        PackedUserOperation memory op = _authorize(_op(0, _calls(42)), wrongKey, 0, commitment1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
        require(target.value() == 0, "wrong owner spent");
    }

    function testOwnerOperationCannotCrossChainOrAccount() public {
        PackedUserOperation memory op = _authorize(_op(0, _calls(42)), owner0, 0, commitment1);
        vm.chainId(8453);
        vm.expectRevert();
        _submit(op);
        vm.chainId(1);
        op.sender = _deploy(1, commitment0);
        vm.deal(op.sender, 1 ether);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
    }

    function testBootstrapAndCurrentKeyCannotUseOrdinarySafeSignatures() public {
        bytes memory data = abi.encodeCall(Target.set, (42));
        bytes32 digest = account.getTransactionHash(
            address(target), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), 0
        );
        bytes memory signature = _sign(BOOTSTRAP, digest);
        vm.expectRevert();
        account.execTransaction(
            address(target),
            0,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            signature
        );
        signature = _sign(owner0, digest);
        vm.expectRevert();
        account.execTransaction(
            address(target),
            0,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            signature
        );
        // Safe's contract-owner signature path must not turn arbitrary data into authority.
        signature = abi.encodePacked(
            bytes32(uint256(uint160(address(module)))), bytes32(uint256(65)), uint8(0), bytes32(0)
        );
        vm.expectRevert();
        account.execTransaction(
            address(target),
            0,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            signature
        );
        vm.expectRevert();
        account.approveHash(digest);
        _assertOwner(commitment0, 0);
        require(target.value() == 0, "ordinary Safe signature bypass");
    }

    function testMalformedSignaturesAndOversizedCallBatchesFailBeforeConsumption() public {
        PackedUserOperation memory op = _op(0, _calls(42));
        op.signature = hex"1234";
        vm.expectRevert();
        _submit(op);
        BunkModule.Call[] memory calls = new BunkModule.Call[](17);
        for (uint256 i = 0; i < calls.length; ++i) {
            calls[i] = BunkModule.Call(address(target), 0, abi.encodeCall(Target.set, (i)));
        }
        op = _authorize(
            _op(0, abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls))),
            owner0,
            0,
            commitment1
        );
        vm.expectRevert();
        _submit(op);
        op = _authorize(_op(0, new bytes(6145)), owner0, 0, commitment1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
    }

    function _paymaster(uint128 costCap) private returns (BunkPaymaster paymaster) {
        paymaster = new BunkPaymaster(entryPoint, module, vm.addr(SPONSOR), costCap, address(this));
        vm.deal(address(this), 1 ether);
        paymaster.deposit{value: 1 ether}();
        paymaster.setBudget(1 ether);
    }

    function _sponsor(PackedUserOperation memory op, BunkPaymaster paymaster, uint256 nonce)
        private
        returns (PackedUserOperation memory)
    {
        op.paymasterAndData =
            abi.encodePacked(address(paymaster), uint128(500_000), uint128(10_000));
        BunkPaymaster.Sponsorship memory sponsorship = BunkPaymaster.Sponsorship({
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 1 hours),
            maxCost: 0.01 ether,
            nonce: nonce,
            epoch: paymaster.sponsorEpoch(),
            signature: ""
        });
        sponsorship.signature = _sign(SPONSOR, paymaster.sponsorshipDigest(op, sponsorship));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, abi.encode(sponsorship));
        require(op.paymasterAndData.length == 404, "sponsor wire format");
        return op;
    }

    function testHoneySponsorshipPaysForAnUnfundedWallet() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        vm.deal(address(account), 0);
        PackedUserOperation memory op =
            _authorize(_sponsor(_op(0, _calls(42)), paymaster, 7), owner0, 0, commitment1);
        vm.recordLogs();
        _submit(op);
        _assertResult(entryPoint.getUserOpHash(op), true);
        _assertOwner(commitment1, 1);
        require(target.value() == 42 && address(account).balance == 0, "sponsorship execution");
        require(
            paymaster.usedNonce(7) && paymaster.remainingBudget() < 1 ether,
            "liability not reserved"
        );
        require(entryPoint.balanceOf(address(paymaster)) < 1 ether, "Honey did not pay");
    }

    function testSponsoredCounterfactualDeploymentAndFirstOperation() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        address identity = vm.addr(BOOTSTRAP);
        bytes memory certificate =
            _sign(BOOTSTRAP, factory.deploymentDigest(identity, 1, _commitment(OWNER2)));
        PackedUserOperation memory op = _op(0, _calls(42));
        op.sender = factory.predictAccount(identity, 1);
        op.initCode = abi.encodePacked(
            address(factory),
            abi.encodeCall(BunkFactory.deploy, (identity, 1, _commitment(OWNER2), certificate))
        );
        op = _authorize(_sponsor(op, paymaster, 7), OWNER2, 0, commitment1);
        require(
            op.sender.code.length == 0 && op.sender.balance == 0, "account must be counterfactual"
        );
        vm.recordLogs();
        _submit(op);
        _assertResult(entryPoint.getUserOpHash(op), true);
        require(
            op.sender.code.length != 0 && target.value() == 42, "first op did not deploy/execute"
        );
        (bytes32 current, uint32 index) = module.ownerState(op.sender);
        require(current == commitment1 && index == 1, "first owner not consumed");
        require(
            paymaster.usedNonce(7) && entryPoint.balanceOf(address(paymaster)) < 1 ether,
            "deployment was not sponsored"
        );
    }

    function testSponsorshipCannotBeChangedOrReused() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        PackedUserOperation memory op = _sponsor(_op(0, _calls(42)), paymaster, 7);
        op.callData = _calls(99);
        op = _authorize(op, owner0, 0, commitment1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
        require(
            !paymaster.usedNonce(7) && paymaster.remainingBudget() == 1 ether,
            "bad grant consumed budget"
        );
        _submit(_authorize(_sponsor(_op(0, _calls(42)), paymaster, 7), owner0, 0, commitment1));
        op = _authorize(_sponsor(_op(1, _calls(99)), paymaster, 7), owner1, 1, _commitment(OWNER2));
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment1, 1);
    }

    function testSponsorshipBudgetAndPerOperationCapAreEnforced() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        paymaster.setBudget(1);
        PackedUserOperation memory op =
            _authorize(_sponsor(_op(0, _calls(42)), paymaster, 7), owner0, 0, commitment1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
        require(paymaster.remainingBudget() == 1, "budget underflow");
        paymaster = _paymaster(1);
        op = _authorize(_sponsor(_op(0, _calls(42)), paymaster, 8), owner0, 0, commitment1);
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
    }

    function testSponsorEpochRevokesOldGrantsEvenWithSameSigner() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        PackedUserOperation memory op =
            _authorize(_sponsor(_op(0, _calls(42)), paymaster, 7), owner0, 0, commitment1);
        paymaster.setSponsorSigner(vm.addr(SPONSOR));
        vm.expectRevert();
        _submit(op);
        _assertOwner(commitment0, 0);
        _submit(_authorize(_sponsor(_op(0, _calls(42)), paymaster, 7), owner0, 0, commitment1));
        _assertOwner(commitment1, 1);
    }

    function testRevertedSponsoredCallStillPaysAndConsumesOwner() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        BunkModule.Call[] memory calls = new BunkModule.Call[](1);
        calls[0] = BunkModule.Call(address(target), 0, abi.encodeCall(Target.fail, ()));
        PackedUserOperation memory op =
            _op(0, abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls)));
        op = _authorize(_sponsor(op, paymaster, 7), owner0, 0, commitment1);
        vm.recordLogs();
        _submit(op);
        _assertResult(entryPoint.getUserOpHash(op), false);
        _assertOwner(commitment1, 1);
        require(
            paymaster.usedNonce(7) && paymaster.remainingBudget() < 1 ether,
            "failed-call accounting"
        );
        require(
            entryPoint.balanceOf(address(paymaster)) < 1 ether, "failed sponsorship not charged"
        );
    }

    function testSponsorshipAdminAndValidationAreRestricted() public {
        BunkPaymaster paymaster = _paymaster(0.01 ether);
        vm.prank(address(0xdead));
        vm.expectRevert();
        paymaster.setBudget(type(uint256).max);
        vm.prank(address(0xdead));
        vm.expectRevert();
        paymaster.setSponsorSigner(address(0xdead));
        PackedUserOperation memory op = _sponsor(_op(0, _calls(42)), paymaster, 7);
        vm.expectRevert();
        paymaster.validatePaymasterUserOp(op, bytes32(0), 1);
        require(
            paymaster.remainingBudget() == 1 ether && !paymaster.usedNonce(7),
            "unauthorized accounting"
        );
    }

    function testFactoryStakeLifecycleHasNoWalletAuthority() public {
        vm.deal(address(this), 1 ether);
        factory.addStake{value: 0.1 ether}(1 days);
        IStakeManager.DepositInfo memory info = entryPoint.getDepositInfo(address(factory));
        require(
            info.staked && info.stake == 0.1 ether && info.unstakeDelaySec == 1 days,
            "factory stake"
        );
        vm.prank(address(0xdead));
        vm.expectRevert();
        factory.unlockStake();
        factory.unlockStake();
        vm.expectRevert();
        factory.withdrawStake(payable(address(0xbeef)));
        vm.warp(block.timestamp + 1 days);
        factory.withdrawStake(payable(address(0xbeef)));
        require(address(0xbeef).balance == 0.1 ether, "stake withdrawal");
        _assertOwner(commitment0, 0);
        // Treasury administration does not make this test contract a Safe owner.
        vm.expectRevert();
        account.enableModule(address(this));
    }
}
