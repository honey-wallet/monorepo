// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {BunkSeedRecoveryModule as Account} from "../src/BunkSeedRecoveryModule.sol";
import {BunkSeedRecoveryFactory as Factory} from "../src/BunkSeedRecoveryFactory.sol";
import {BunkFactory} from "../src/BunkFactory.sol";
import {Safe} from "safe/Safe.sol";
import {SafeProxyFactory} from "safe/proxies/SafeProxyFactory.sol";
import {Enum} from "safe/common/Enum.sol";
import {BunkPaymaster} from "../src/BunkPaymaster.sol";
import {BunkModule} from "../src/BunkModule.sol";
import {Vm, Target} from "./BunkIntegration.t.sol";

contract SeedRecoveryRelay {
    Account immutable module;
    address immutable account;
    bytes32 immutable nextOwner;
    bytes32 immutable nextRecovery;
    bytes signature;

    constructor(Account m, address a, bytes32 o, bytes32 r, bytes memory s) {
        module = m;
        account = a;
        nextOwner = o;
        nextRecovery = r;
        signature = s;
    }

    function recover() external {
        module.recoverFromSeed(account, 0, nextOwner, nextRecovery, signature);
    }
}

contract BunkSeedRecoveryIntegrationTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER = 0x1111;
    uint256 private constant NEXT = 0x2222;
    uint256 private constant ENVELOPE = 0x3333;
    uint256 private constant RECOVERY = 0x90001;
    uint256 private constant RECOVERY_NEXT = 0x90002;
    uint256 private constant GENERATION_OWNER = 0xa001;
    uint256 private constant SPONSOR = 0x4444;
    EntryPoint private ep;
    uint256 private constant BOOTSTRAP = 0xb0057;
    Safe private account;
    Safe private singleton;
    SafeProxyFactory private proxyFactory;
    Factory private factory;
    Account private module;

    function _ownerIndex() private view returns (uint32 index) {
        (, index) = module.ownerState(address(account));
    }

    function _currentCommitment() private view returns (bytes32 value) {
        (value,) = module.ownerState(address(account));
    }

    function _deploy(uint32 index, bytes32 initial) private returns (address) {
        address identity = vm.addr(BOOTSTRAP);
        return factory.deploy(
            identity,
            index,
            initial,
            _commitment(RECOVERY),
            _sign(
                BOOTSTRAP, factory.deploymentDigest(identity, index, initial, _commitment(RECOVERY))
            )
        );
    }

    function _initialCode(uint32 index, bytes32 initial) private returns (bytes memory) {
        address identity = vm.addr(BOOTSTRAP);
        return abi.encodePacked(
            address(factory),
            abi.encodeCall(
                Factory.deploy,
                (
                    identity,
                    index,
                    initial,
                    _commitment(RECOVERY),
                    _sign(
                        BOOTSTRAP,
                        factory.deploymentDigest(identity, index, initial, _commitment(RECOVERY))
                    )
                )
            )
        );
    }
    Target private target;
    BunkPaymaster private paymaster;
    uint256 private ownerSignatures;
    uint256 private attemptCounter;
    uint256 private envelopeBase;
    bytes32[511] private tree;
    mapping(uint256 => bool) private envelopeSigned;

    function _buildTree(uint256 base) private {
        envelopeBase = base;
        attemptCounter = 0;
        for (uint256 i; i < 256; i++) {
            tree[255 + i] =
                keccak256(abi.encodePacked(keccak256(abi.encode(uint8(i), vm.addr(base + i)))));
        }
        for (uint256 i = 255; i > 0;) {
            i--;
            bytes32 left = tree[i * 2 + 1];
            bytes32 right = tree[i * 2 + 2];
            tree[i] = left < right
                ? keccak256(abi.encodePacked(left, right))
                : keccak256(abi.encodePacked(right, left));
        }
    }

    function _proof(uint8 attempt) private view returns (bytes32[] memory proof) {
        proof = new bytes32[](8);
        uint256 index = 255 + uint256(attempt);
        for (uint256 i; i < 8; i++) {
            proof[i] = tree[index % 2 == 1 ? index + 1 : index - 1];
            index = (index - 1) / 2;
        }
    }

    function setUp() public {
        _buildTree(ENVELOPE);
        vm.chainId(1);
        vm.warp(1000);
        ep = new EntryPoint();
        singleton = new Safe();
        proxyFactory = new SafeProxyFactory();
        factory = new Factory(singleton, proxyFactory, address(ep), address(this));
        module = factory.module();
        account = Safe(payable(_deploy(0, _commitment(OWNER))));
        target = new Target();
        vm.deal(address(account), 10 ether);
        vm.deal(address(this), 20 ether);
        paymaster = new BunkPaymaster(
            ep, BunkModule(address(module)), vm.addr(SPONSOR), 0.1 ether, address(this)
        );
        paymaster.deposit{value: 10 ether}();
        paymaster.setBudget(10 ether);
    }

    function _commitment(uint256 key) private returns (bytes32) {
        return keccak256(abi.encodePacked(vm.addr(key)));
    }

    function _sign(uint256 key, bytes32 digest) private returns (bytes memory) {
        if (key == OWNER) ownerSignatures++;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _op() private view returns (PackedUserOperation memory op) {
        Account.Call[] memory calls = new Account.Call[](1);
        calls[0] = Account.Call(address(target), 0, abi.encodeCall(Target.set, (42)));
        op.sender = address(account);
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
        op.accountGasLimits = bytes32(uint256(500_000) << 128 | uint256(500_000));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(uint256(1 gwei) << 128 | uint256(1 gwei));
    }

    function _certificate(PackedUserOperation memory op)
        private
        returns (Account.Certificate memory c)
    {
        c = Account.Certificate({
            entryPoint: address(ep),
            account: op.sender,
            nonce: op.nonce,
            callDataHash: keccak256(op.callData),
            accountGasLimits: op.accountGasLimits,
            preVerificationGas: op.preVerificationGas,
            maxGasCost: 0.01 ether,
            paymaster: address(paymaster),
            ownerIndex: 0,
            nextCommitment: _commitment(NEXT),
            envelopeRoot: tree[0],
            validAfter: 1000,
            executeUntil: 1100
        });
    }

    function _ownerApproval(Account.Certificate memory c) private returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("HoneyBunkOwner"),
                keccak256("3"),
                block.chainid,
                address(module)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                hex"1901", domain, keccak256(abi.encode(module.CERTIFICATE_TYPEHASH(), c))
            )
        );
        if (c.account == address(account)) {
            require(digest == module.certificateDigest(c), "typed hash drift");
        }
        return _sign(OWNER, digest);
    }

    function _envelope(
        PackedUserOperation memory op,
        Account.Certificate memory c,
        bytes memory ownerSig
    ) private returns (PackedUserOperation memory) {
        require(attemptCounter < 256, "retry set exhausted");
        uint8 attempt = uint8(attemptCounter++);
        uint256 key = envelopeBase + attempt;
        require(!envelopeSigned[key], "envelope key reused");
        envelopeSigned[key] = true;
        op.signature = abi.encode(
            Account.Authorization(
                c, attempt, _proof(attempt), ownerSig, _sign(key, ep.getUserOpHash(op))
            )
        );
        return op;
    }

    function _sponsor(
        PackedUserOperation memory op,
        uint256 grantNonce,
        uint48 after_,
        uint48 until_
    ) private returns (PackedUserOperation memory) {
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(200_000), uint128(0));
        BunkPaymaster.Sponsorship memory grant = BunkPaymaster.Sponsorship(
            after_, until_, 0.01 ether, grantNonce, paymaster.sponsorEpoch(), ""
        );
        grant.signature = _sign(SPONSOR, paymaster.sponsorshipDigest(op, grant));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, abi.encode(grant));
        return op;
    }

    function _submit(PackedUserOperation memory op) private {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        ep.handleOps(ops, payable(address(0xbeef)));
    }

    function _unchanged() private view {
        require(
            _ownerIndex() == 0 && ep.getNonce(address(account), 0) == 0, "rejection consumed owner"
        );
    }

    function _consumedOnce() private {
        require(ownerSignatures == 1, "owner signed more than once");
        require(_ownerIndex() == 1 && _currentCommitment() == _commitment(NEXT), "rotation failed");
        require(ep.getNonce(address(account), 0) == 1, "wrong nonce");
        require(
            module.usedCommitment(address(account), _commitment(OWNER)), "lost consumed key marker"
        );
        require(
            module.usedCommitment(address(account), _commitment(NEXT)), "current key not recognized"
        );
        require(!module.usedCommitment(address(account), bytes32(0)), "zero key recognized");
    }

    function testFeeRetryUsesOneOwnerSignatureAndFreshExactEnvelope() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        // A relay cannot edit fees in an existing envelope.
        op.gasFees = bytes32(uint256(2 gwei) << 128 | uint256(2 gwei));
        vm.expectRevert();
        _submit(op);
        _unchanged();
        op = _envelope(op, c, ownerSig);
        _submit(op);
        _consumedOnce();
        require(target.value() == 42, "action not executed");
        vm.expectRevert();
        _submit(op);
    }

    function testExpiredGrantRenewalRotatesWithoutExecutingExpiredAction() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(_sponsor(op, 1, 1000, 1100), c, ownerSig);
        vm.warp(1101);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        require(!paymaster.usedNonce(1), "rejected grant consumed");
        op = _envelope(_sponsor(op, 2, 1101, 1200), c, ownerSig);
        vm.recordLogs();
        _submit(op);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool skipped;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(module)
                    && logs[i].topics[0] == keccak256("ExpiredActionSkipped(address,bytes32)")
            ) skipped = true;
        }
        require(skipped && target.value() == 0, "expired action executed or no skip evidence");
        require(paymaster.usedNonce(2), "renewed grant unused");
        _consumedOnce();
    }

    function testRevokedSponsorshipFallsBackWithinSignedGasBudget() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(_sponsor(op, 1, 1000, 1100), c, ownerSig);
        paymaster.setSponsorSigner(vm.addr(0x5555));
        vm.expectRevert();
        _submit(op);
        _unchanged();
        vm.warp(1200);
        op.paymasterAndData = "";
        op = _envelope(op, c, ownerSig);
        uint256 beforeBalance = address(account).balance + ep.balanceOf(address(account));
        _submit(op);
        _consumedOnce();
        uint256 spent = beforeBalance - address(account).balance - ep.balanceOf(address(account));
        require(
            spent > 0 && spent <= c.maxGasCost && target.value() == 0,
            "fallback liability/action invalid"
        );
    }

    function testDeadlineBoundaryExecutesAtDeadline() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        vm.warp(c.executeUntil);
        _submit(_envelope(op, c, ownerSig));
        _consumedOnce();
        require(target.value() == 42, "inclusive deadline changed");
    }

    function testCannotConsumeBeforeSignedStart() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        vm.warp(999);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        vm.warp(1000);
        _submit(op);
        _consumedOnce();
    }

    function testLiveRevertConsumesOwner() public {
        PackedUserOperation memory op = _op();
        Account.Call[] memory calls = new Account.Call[](1);
        calls[0] = Account.Call(address(target), 0, abi.encodeCall(Target.fail, ()));
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        _submit(op);
        _consumedOnce();
        (bool authorized,) = module.reservation(address(account), ep.getUserOpHash(op));
        require(authorized, "execution did not revert");
    }

    function testEnvelopeKeyCannotChangeOwnerApprovedScope() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        c.nextCommitment = _commitment(0x7777);
        op = _envelope(op, c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function testEnvelopeKeyCannotLowerGasOrChangeCallsOrNonce() public {
        for (uint256 mode; mode < 4; mode++) {
            PackedUserOperation memory op = _op();
            Account.Certificate memory c = _certificate(op);
            bytes memory ownerSig = _ownerApproval(c);
            if (mode == 0) {
                op.accountGasLimits = bytes32(uint256(500_000) << 128 | uint256(10_000));
            }
            if (mode == 1) op.callData = abi.encodePacked(op.callData, bytes32(0));
            if (mode == 2) op.nonce = 1;
            if (mode == 3) op.preVerificationGas++;
            op = _envelope(op, c, ownerSig);
            vm.expectRevert();
            _submit(op);
            _unchanged();
        }
    }

    function testEnvelopeCannotExceedSignedLiabilityOrSwapPaymaster() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op.gasFees = bytes32(uint256(100 gwei) << 128 | uint256(100 gwei));
        op = _envelope(op, c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        op.gasFees = bytes32(uint256(1 gwei) << 128 | uint256(1 gwei));
        op = _sponsor(op, 1, 1000, 1100);
        // Mutating a certificate also requires the owner signature, not just the envelope key.
        c.paymaster = address(0x1234);
        op = _envelope(op, c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function testFactoryFrontRunCanRemoveInitCodeWithoutNewOwnerSignature() public {
        bytes32 initial = _commitment(OWNER);
        address predicted = factory.predictAccount(vm.addr(BOOTSTRAP), 1);
        PackedUserOperation memory op = _op();
        op.sender = predicted;
        op.initCode = _initialCode(1, initial);
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        _deploy(1, initial); // An external certificate relay wins the deployment race.
        account = Safe(payable(predicted));
        vm.deal(predicted, 10 ether);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        op.initCode = "";
        op = _envelope(op, c, ownerSig);
        _submit(op);
        _consumedOnce();
        require(target.value() == 42, "front-run stranded action");
    }

    function testNextOwnerActsAfterExpiredRecovery() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        vm.warp(1200);
        _submit(_envelope(op, c, ownerSig));
        _consumedOnce();
        require(target.value() == 0, "expired calls ran");
        op.nonce = 1;
        c.nonce = 1;
        c.ownerIndex = 1;
        c.nextCommitment = _commitment(0x9999);
        _buildTree(ENVELOPE + 256);
        c.envelopeRoot = tree[0];
        c.validAfter = 1200;
        c.executeUntil = 1300;
        op = _envelope(op, c, _sign(NEXT, module.certificateDigest(c)));
        _submit(op);
        require(target.value() == 42 && _ownerIndex() == 2, "recovery stranded successor");
        require(ownerSignatures == 1, "first owner reused");
    }

    function testFuzzCertificateMutationRejected(uint8 field) public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        field %= 13;
        if (field == 0) c.entryPoint = address(1);
        if (field == 1) c.account = address(1);
        if (field == 2) c.nonce++;
        if (field == 3) c.callDataHash ^= bytes32(uint256(1));
        if (field == 4) c.accountGasLimits ^= bytes32(uint256(1));
        if (field == 5) c.preVerificationGas++;
        if (field == 6) c.maxGasCost++;
        if (field == 7) c.paymaster = address(1);
        if (field == 8) c.ownerIndex++;
        if (field == 9) c.nextCommitment = bytes32(uint256(1));
        if (field == 10) c.envelopeRoot = bytes32(uint256(1));
        if (field == 11) c.validAfter--;
        if (field == 12) c.executeUntil++;
        op = _envelope(op, c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function _recovery(PackedUserOperation memory op, Account.Certificate memory c)
        private
        pure
        returns (PackedUserOperation memory)
    {
        Account.Call[] memory empty = new Account.Call[](0);
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(empty));
        op.initCode = "";
        op.paymasterAndData = "";
        uint256 totalGas = uint128(bytes16(c.accountGasLimits))
            + uint256(uint128(uint256(c.accountGasLimits))) + c.preVerificationGas;
        uint256 fee = c.maxGasCost / totalGas;
        op.gasFees = bytes32(fee << 128 | fee);
        return op;
    }

    function testReservedLeafRecoversOnlyAfterExpiryWithIdenticalBytes() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        attemptCounter = 255;
        op = _envelope(_recovery(op, c), c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        vm.warp(1101);
        _submit(op);
        _consumedOnce();
        require(target.value() == 0, "reserved leaf executed calls");
        vm.expectRevert();
        _submit(op);
    }

    function testReservedLeafRejectsExpiringGrant() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        attemptCounter = 255;
        op = _envelope(_sponsor(_recovery(op, c), 1, 1000, 1100), c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        // A second signature is unnecessary: removing the grant invalidates the exact envelope.
        op.paymasterAndData = "";
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function testReservedLeafRejectsVariableFeesEvenWithinBudget() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        attemptCounter = 255;
        op = _recovery(op, c);
        op.gasFees = bytes32(uint256(1 gwei) << 128 | uint256(1 gwei));
        op = _envelope(op, c, ownerSig);
        vm.warp(1101);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function testAllOrdinaryLeavesCanBeReservedWithoutBurningRecovery() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        for (uint256 i; i < 255; i++) {
            uint256 fee = 1 gwei + i;
            op.gasFees = bytes32(fee << 128 | fee);
            _envelope(op, c, ownerSig); // Each distinct attempt was signed but never included.
        }
        require(attemptCounter == 255, "wrong recovery reservation");
        vm.warp(1101);
        op = _envelope(_recovery(op, c), c, ownerSig);
        _submit(op);
        _consumedOnce();
        require(target.value() == 0, "recovery executed dropped actions");
    }

    function testWrongMerkleLeafCannotUseAnotherProof() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        Account.Authorization memory a = abi.decode(op.signature, (Account.Authorization));
        a.attempt = 1;
        op.signature = abi.encode(a);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function testSignatureDomainRejectsDifferentChain() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        vm.chainId(8453);
        op = _envelope(op, c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function _authorize(PackedUserOperation memory op, uint256 key, uint32 index, bytes32 next)
        private
        returns (PackedUserOperation memory)
    {
        Account.Certificate memory c = _certificate(op);
        c.ownerIndex = index;
        c.nextCommitment = next;
        return _envelope(op, c, _sign(key, module.certificateDigest(c)));
    }

    function testExactSafeConfigurationAndNoReinitialization() public {
        address[] memory owners = account.getOwners();
        (address[] memory modules, address sentinel) = account.getModulesPaginated(address(1), 2);
        require(
            owners.length == 1 && owners[0] == address(module) && account.getThreshold() == 1,
            "owner bypass"
        );
        require(
            modules.length == 1 && modules[0] == address(module) && sentinel == address(1),
            "module bypass"
        );
        require(
            abi.decode(account.getStorageAt(0, 1), (address)) == address(singleton),
            "wrong singleton"
        );
        require(
            abi.decode(
                account.getStorageAt(
                    0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5, 1
                ),
                (address)
            ) == address(module),
            "wrong fallback"
        );
        require(
            abi.decode(
                account.getStorageAt(
                    0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8, 1
                ),
                (address)
            ) == address(0),
            "unexpected guard"
        );
        vm.expectRevert();
        module.initialize();
        (bool helperSetup,) = address(factory.helper()).call(abi.encodeWithSignature("setup()"));
        require(!helperSetup, "direct helper setup succeeded");
        vm.expectRevert();
        factory.consumeBootstrap(address(account));
        address identity = vm.addr(BOOTSTRAP);
        bytes32 initial = _commitment(OWNER);
        bytes memory bootstrap =
            _sign(BOOTSTRAP, factory.deploymentDigest(identity, 0, initial, _commitment(RECOVERY)));
        vm.expectRevert();
        factory.deploy(identity, 0, initial, _commitment(RECOVERY), bootstrap);
        _unchanged();
    }

    function testDirectProxyFactoryFirstClaimHasNoBootstrapRecord() public {
        address identity = vm.addr(BOOTSTRAP);
        address predicted = factory.predictAccount(identity, 1);
        bytes memory initializer = factory.initializer();
        uint256 salt = factory.saltNonce(identity, 1);
        vm.expectRevert();
        proxyFactory.createProxyWithNonce(address(singleton), initializer, salt);
        require(predicted.code.length == 0, "unauthorized first claim");
        require(_deploy(1, _commitment(OWNER)) == predicted, "authorized deployment failed");
    }

    function testDeploymentDomainAndIdentityBinding() public {
        address identity = vm.addr(BOOTSTRAP);
        bytes32 initial = _commitment(OWNER);
        bytes memory sig =
            _sign(BOOTSTRAP, factory.deploymentDigest(identity, 1, initial, _commitment(RECOVERY)));
        vm.expectRevert();
        factory.deploy(identity, 2, initial, _commitment(RECOVERY), sig);
        vm.expectRevert();
        factory.deploy(identity, 1, _commitment(NEXT), _commitment(RECOVERY), sig);
        vm.chainId(8453);
        vm.expectRevert();
        factory.deploy(identity, 1, initial, _commitment(RECOVERY), sig);
        vm.chainId(1);
        BunkFactory oldFactory =
            new BunkFactory(singleton, proxyFactory, address(ep), address(this));
        bytes memory oldSignature =
            _sign(BOOTSTRAP, oldFactory.deploymentDigest(identity, 1, initial));
        vm.expectRevert();
        factory.deploy(identity, 1, initial, _commitment(RECOVERY), oldSignature);
        vm.warp(1000 + 365 days);
        require(
            factory.deploy(identity, 1, initial, _commitment(RECOVERY), sig)
                == factory.predictAccount(identity, 1),
            "permanent bootstrap failed"
        );
    }

    function testSponsoredCounterfactualCreationAtBoundedVerificationGas() public {
        PackedUserOperation memory op = _op();
        op.sender = factory.predictAccount(vm.addr(BOOTSTRAP), 1);
        op.initCode = _initialCode(1, _commitment(OWNER));
        op = _sponsor(op, 1, 1000, 1100);
        op = _authorize(op, OWNER, 0, _commitment(NEXT));
        _submit(op);
        account = Safe(payable(op.sender));
        _consumedOnce();
        require(target.value() == 42 && address(account).balance == 0, "unfunded creation failed");
    }

    function testDirectAndSpoofedEntryPointCallsFail() public {
        PackedUserOperation memory op = _authorize(_op(), OWNER, 0, _commitment(NEXT));
        bytes32 hash = ep.getUserOpHash(op);
        vm.expectRevert();
        module.executeUserOp(op, hash);
        vm.expectRevert();
        Account(address(account)).executeUserOp(op, hash);
        vm.expectRevert();
        module.validateUserOp(op, hash, 0);
        (bool success,) = address(account)
            .call(abi.encodePacked(abi.encodeCall(Account.executeUserOp, (op, hash)), address(ep)));
        require(!success, "spoofed EntryPoint suffix");
        vm.prank(address(ep));
        vm.expectRevert();
        module.executeUserOp(op, hash);
        _unchanged();
    }

    function testSelfAdministrationAndUnapprovedModulesFail() public {
        Account.Call[] memory calls = new Account.Call[](1);
        calls[0] = Account.Call(
            address(account), 0, abi.encodeCall(account.enableModule, (address(this)))
        );
        PackedUserOperation memory op = _op();
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
        op = _authorize(op, OWNER, 0, _commitment(NEXT));
        vm.expectRevert();
        _submit(op);
        vm.expectRevert();
        account.enableModule(address(this));
        vm.expectRevert();
        account.execTransactionFromModule(
            address(target), 0, abi.encodeCall(Target.set, (3)), Enum.Operation.Call
        );
        _unchanged();
    }

    function testOrdinarySafeOwnerAndContractSignaturesCannotBypassRotation() public {
        bytes memory data = abi.encodeCall(Target.set, (42));
        bytes32 digest = account.getTransactionHash(
            address(target), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), 0
        );
        bytes[] memory signatures = new bytes[](4);
        signatures[0] = _sign(BOOTSTRAP, digest);
        signatures[1] = _sign(OWNER, digest);
        signatures[2] = abi.encodePacked(
            bytes32(uint256(uint160(address(module)))), bytes32(uint256(65)), uint8(0), bytes32(0)
        );
        signatures[3] =
            abi.encodePacked(bytes32(uint256(uint160(address(module)))), bytes32(0), uint8(1));
        for (uint256 i; i < signatures.length; i++) {
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
                signatures[i]
            );
        }
        vm.expectRevert();
        account.approveHash(digest);
        _unchanged();
        require(target.value() == 0, "ordinary execution bypass");
    }

    function testAtomicBatchFailurePreservesRotationButRollsBackActions() public {
        Account.Call[] memory calls = new Account.Call[](2);
        calls[0] = Account.Call(address(target), 0, abi.encodeCall(Target.set, (42)));
        calls[1] = Account.Call(address(target), 0, abi.encodeCall(Target.fail, ()));
        PackedUserOperation memory op = _op();
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
        _submit(_authorize(op, OWNER, 0, _commitment(NEXT)));
        _consumedOnce();
        require(target.value() == 0, "partial batch effects retained");
    }

    function testNoPrefundRecoveryCanRetryIdenticalBytesAfterFunding() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        attemptCounter = 255;
        op = _envelope(_recovery(op, c), c, ownerSig);
        vm.warp(1101);
        vm.deal(address(account), 0);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        vm.warp(1101 + 365 days);
        vm.deal(address(account), 1 ether);
        _submit(op);
        _consumedOnce();
        require(target.value() == 0, "funding retry executed stale action");
    }

    function testSequentialOwnersInOneBundleAndNoOldCommitmentReactivation() public {
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        ops[0] = _authorize(_op(), OWNER, 0, _commitment(NEXT));
        _buildTree(ENVELOPE + 256);
        ops[1] = _op();
        ops[1].nonce = 1;
        ops[1] = _authorize(ops[1], NEXT, 1, _commitment(0x9999));
        ep.handleOps(ops, payable(address(0xbeef)));
        require(
            _ownerIndex() == 2 && ep.getNonce(address(account), 0) == 2, "bundle rotation failed"
        );
        _buildTree(ENVELOPE + 512);
        PackedUserOperation memory rollback = _op();
        rollback.nonce = 2;
        rollback = _authorize(rollback, 0x9999, 2, _commitment(OWNER));
        vm.expectRevert();
        _submit(rollback);
        require(_ownerIndex() == 2, "reactivated old commitment");
    }

    function testWrongAccountAndHighSSignaturesCannotAuthorize() public {
        PackedUserOperation memory op = _op();
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        Account.Authorization memory auth = abi.decode(op.signature, (Account.Authorization));
        (uint8 v, bytes32 r, bytes32 sigS) = vm.sign(OWNER, module.certificateDigest(c));
        auth.ownerSignature = abi.encodePacked(
            r,
            bytes32(
                0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(sigS)
            ),
            v == 27 ? uint8(28) : uint8(27)
        );
        op.signature = abi.encode(auth);
        vm.expectRevert();
        _submit(op);
        _unchanged();
        op.sender = _deploy(1, _commitment(OWNER));
        vm.deal(op.sender, 1 ether);
        op = _envelope(op, c, ownerSig);
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function testMalformedAndOversizedAuthorizationFailsBeforeConsumption() public {
        PackedUserOperation memory op = _op();
        op.signature = hex"1234";
        vm.expectRevert();
        _submit(op);
        _unchanged();
        op = _authorize(_op(), OWNER, 0, _commitment(NEXT));
        op.signature = abi.encodePacked(op.signature, bytes32(0));
        vm.expectRevert();
        _submit(op);
        _unchanged();
        op = _op();
        op.callData = new bytes(6145);
        op = _authorize(op, OWNER, 0, _commitment(NEXT));
        vm.expectRevert();
        _submit(op);
        _unchanged();
    }

    function _withdrawal(uint256 amount) private view returns (PackedUserOperation memory op) {
        Account.Call[] memory calls = new Account.Call[](1);
        calls[0] = Account.Call(
            address(ep), 0, abi.encodeCall(ep.withdrawTo, (payable(address(account)), amount))
        );
        op = _op();
        op.callData = abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
    }

    function testSponsoredWithdrawalReturnsEntireGasDepositToSameSafe() public {
        ep.depositTo{value: 1 ether}(address(account));
        uint256 balanceBefore = address(account).balance;
        PackedUserOperation memory op =
            _authorize(_sponsor(_withdrawal(1 ether), 1, 1000, 1100), OWNER, 0, _commitment(NEXT));
        _submit(op);
        _consumedOnce();
        require(ep.balanceOf(address(account)) == 0, "gas deposit stranded");
        require(address(account).balance == balanceBefore + 1 ether, "refund not returned to Safe");
    }

    function testSelfFundedWithdrawalPreservesGasAccounting() public {
        ep.depositTo{value: 1 ether}(address(account));
        uint256 balanceBefore = address(account).balance;
        _submit(_authorize(_withdrawal(0.5 ether), OWNER, 0, _commitment(NEXT)));
        _consumedOnce();
        require(address(account).balance == balanceBefore + 0.5 ether, "wrong withdrawal");
        uint256 remaining = ep.balanceOf(address(account));
        require(remaining > 0 && remaining < 0.5 ether, "gas was not accounted from deposit");
    }

    function testEntryPointExceptionRejectsOtherRecipientMethodValueOrEncoding() public {
        for (uint256 mode; mode < 5; mode++) {
            Account.Call[] memory calls = new Account.Call[](1);
            bytes memory data =
                abi.encodeCall(ep.withdrawTo, (payable(address(account)), 0.5 ether));
            if (mode == 0) {
                data = abi.encodeCall(ep.withdrawTo, (payable(address(0xbeef)), 0.5 ether));
            }
            if (mode == 1) data = abi.encodeCall(ep.depositTo, (address(account)));
            if (mode == 2) data = abi.encodePacked(data, bytes1(0));
            if (mode == 3) data[4] = bytes1(uint8(1)); // Dirty high bits in the address word.
            calls[0] = Account.Call(address(ep), mode == 4 ? 1 : 0, data);
            PackedUserOperation memory op = _op();
            op.callData =
                abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
            op = _authorize(op, OWNER, 0, _commitment(NEXT));
            vm.expectRevert();
            _submit(op);
            _unchanged();
        }
    }

    function _seedSignature() private returns (bytes memory) {
        return _sign(
            RECOVERY,
            module.seedRecoveryDigest(
                address(account), 0, _commitment(GENERATION_OWNER), _commitment(RECOVERY_NEXT)
            )
        );
    }

    function _recoverSeed(bytes memory signature) private {
        module.recoverFromSeed(
            address(account),
            0,
            _commitment(GENERATION_OWNER),
            _commitment(RECOVERY_NEXT),
            signature
        );
    }

    function _generationOne() private {
        (bytes32 root, uint32 epoch) = module.recoveryState(address(account));
        require(epoch == 1 && root == _commitment(RECOVERY_NEXT), "wrong recovery state");
        require(
            _ownerIndex() == 0 && _currentCommitment() == _commitment(GENERATION_OWNER),
            "wrong new generation"
        );
    }

    function testSeedRecoveryNeedsNoPendingCertificateAndCannotMoveFunds() public {
        // The owner approved something that never landed. Recovery never sees it.
        _ownerApproval(_certificate(_op()));
        bytes memory recovery = _seedSignature();
        uint256 balance = address(account).balance;
        uint256 deposit = ep.balanceOf(address(account));
        vm.prank(address(0xabad)); // Permissionless relay; no treasury/private server needed.
        _recoverSeed(recovery);
        _generationOne();
        require(
            address(account).balance == balance && ep.balanceOf(address(account)) == deposit,
            "recovery spent wallet funds"
        );
        require(
            target.value() == 0 && ep.getNonce(address(account), 0) == 0,
            "recovery executed action or reset nonce"
        );
        require(ownerSignatures == 1, "lost owner key reused");
        _buildTree(ENVELOPE + 1024);
        _submit(_authorize(_op(), GENERATION_OWNER, 0, _commitment(0xa002)));
        require(target.value() == 42 && _ownerIndex() == 1, "restored owner cannot transact");
    }

    function testSeedRecoveryWorksForEmptySafeAndHasNoExpiry() public {
        bytes memory recovery = _seedSignature();
        vm.deal(address(account), 0);
        vm.warp(1000 + 1000 days);
        _recoverSeed(recovery);
        _generationOne();
        require(address(account).balance == 0, "unexpected balance");
    }

    function testIdenticalRecoveryRemainsValidWhenOrdinaryOwnerAndNonceAdvance() public {
        bytes memory recovery = _seedSignature();
        _submit(_authorize(_op(), OWNER, 0, _commitment(NEXT)));
        _recoverSeed(recovery);
        _generationOne();
        require(ep.getNonce(address(account), 0) == 1, "recovery reset EntryPoint nonce");
        _buildTree(ENVELOPE + 1024);
        PackedUserOperation memory next = _op();
        next.nonce = 1;
        _submit(_authorize(next, GENERATION_OWNER, 0, _commitment(0xa002)));
        require(
            ep.getNonce(address(account), 0) == 2 && _ownerIndex() == 1,
            "new generation nonce mismatch"
        );
    }

    function testSeedRecoveryInvalidatesOldOwnerOperationAndCertificateReplay() public {
        PackedUserOperation memory dropped = _authorize(_op(), OWNER, 0, _commitment(NEXT));
        bytes memory recovery = _seedSignature();
        _recoverSeed(recovery);
        vm.expectRevert();
        _submit(dropped);
        vm.expectRevert();
        _recoverSeed(recovery);
        _generationOne();
        require(target.value() == 0 && ep.getNonce(address(account), 0) == 0, "old action executed");
    }

    function testSeedRecoveryBindsAccountChainModuleAndSuccessors() public {
        bytes memory recovery = _seedSignature();
        vm.expectRevert();
        module.recoverFromSeed(
            address(account), 0, _commitment(0xdead), _commitment(RECOVERY_NEXT), recovery
        );
        vm.expectRevert();
        module.recoverFromSeed(
            address(account), 0, _commitment(GENERATION_OWNER), _commitment(0xdead), recovery
        );
        vm.expectRevert();
        module.recoverFromSeed(
            address(account), 1, _commitment(GENERATION_OWNER), _commitment(RECOVERY_NEXT), recovery
        );
        address other = _deploy(1, _commitment(OWNER));
        vm.expectRevert();
        module.recoverFromSeed(
            other, 0, _commitment(GENERATION_OWNER), _commitment(RECOVERY_NEXT), recovery
        );
        Factory foreignFactory = new Factory(singleton, proxyFactory, address(ep), address(this));
        bytes memory foreignSig = _sign(
            RECOVERY,
            foreignFactory.module()
                .seedRecoveryDigest(
                    address(account), 0, _commitment(GENERATION_OWNER), _commitment(RECOVERY_NEXT)
                )
        );
        vm.expectRevert();
        _recoverSeed(foreignSig);
        vm.chainId(8453);
        vm.expectRevert();
        _recoverSeed(recovery);
        vm.chainId(1);
        bytes memory wrongOwner = _sign(
            OWNER,
            module.seedRecoveryDigest(
                address(account), 0, _commitment(GENERATION_OWNER), _commitment(RECOVERY_NEXT)
            )
        );
        vm.expectRevert();
        _recoverSeed(wrongOwner);
        _unchanged();
    }

    function testOldRecoveryKeyCannotChooseAnotherGenerationAfterConsumption() public {
        _recoverSeed(_seedSignature());
        bytes32 newOwner = _commitment(0xb001);
        bytes32 newRecovery = _commitment(0xb002);
        bytes32 digest = module.seedRecoveryDigest(address(account), 1, newOwner, newRecovery);
        bytes memory oldSig = _sign(RECOVERY, digest);
        vm.expectRevert();
        module.recoverFromSeed(address(account), 1, newOwner, newRecovery, oldSig);
        module.recoverFromSeed(
            address(account), 1, newOwner, newRecovery, _sign(RECOVERY_NEXT, digest)
        );
        (bytes32 root, uint32 epoch) = module.recoveryState(address(account));
        require(
            epoch == 2 && root == newRecovery && _currentCommitment() == newOwner,
            "second recovery failed"
        );
    }

    function testRecoveryRejectsPreviouslyExposedAndCrossRoleCommitments() public {
        _submit(_authorize(_op(), OWNER, 0, _commitment(NEXT)));
        bytes32[5] memory bad = [
            bytes32(0),
            _commitment(OWNER),
            _commitment(NEXT),
            _commitment(RECOVERY),
            _commitment(RECOVERY_NEXT)
        ];
        for (uint256 i; i < bad.length; ++i) {
            bytes memory sig = _sign(
                RECOVERY,
                module.seedRecoveryDigest(address(account), 0, bad[i], _commitment(RECOVERY_NEXT))
            );
            vm.expectRevert();
            module.recoverFromSeed(address(account), 0, bad[i], _commitment(RECOVERY_NEXT), sig);
        }
        _recoverSeed(_seedSignature());
        _buildTree(ENVELOPE + 1024);
        PackedUserOperation memory next = _op();
        next.nonce = 1;
        PackedUserOperation memory badOld =
            _authorize(next, GENERATION_OWNER, 0, _commitment(RECOVERY));
        vm.expectRevert();
        _submit(badOld);
        PackedUserOperation memory badCurrent =
            _authorize(next, GENERATION_OWNER, 0, _commitment(RECOVERY_NEXT));
        vm.expectRevert();
        _submit(badCurrent);
        _generationOne();
    }

    function testRecoveryCancelsAlreadyValidatedLaterBundleActionAndRemainingCalls() public {
        SeedRecoveryRelay relay = new SeedRecoveryRelay(
            module,
            address(account),
            _commitment(GENERATION_OWNER),
            _commitment(RECOVERY_NEXT),
            _seedSignature()
        );
        PackedUserOperation[] memory ops = new PackedUserOperation[](2);
        Account.Call[] memory calls = new Account.Call[](2);
        calls[0] = Account.Call(address(relay), 0, abi.encodeCall(SeedRecoveryRelay.recover, ()));
        calls[1] = Account.Call(address(target), 0, abi.encodeCall(Target.set, (99)));
        ops[0] = _op();
        ops[0].callData =
            abi.encodePacked(IAccountExecute.executeUserOp.selector, abi.encode(calls));
        ops[0] = _authorize(ops[0], OWNER, 0, _commitment(NEXT));
        _buildTree(ENVELOPE + 256);
        ops[1] = _op();
        ops[1].nonce = 1;
        ops[1] = _authorize(ops[1], NEXT, 1, _commitment(0x9999));
        vm.recordLogs();
        ep.handleOps(ops, payable(address(0xbeef)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 cancelled;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(module)
                    && logs[i].topics[0] == keccak256("RecoveryCancelledAction(address,bytes32)")
            ) cancelled++;
        }
        _generationOne();
        require(cancelled == 2 && target.value() == 0, "superseded action ran");
        require(ep.getNonce(address(account), 0) == 2, "validated nonces must remain consumed");
    }

    function testBootstrapBindsRecoveryCommitment() public {
        address identity = vm.addr(BOOTSTRAP);
        bytes32 initial = _commitment(OWNER);
        bytes memory sig =
            _sign(BOOTSTRAP, factory.deploymentDigest(identity, 1, initial, _commitment(RECOVERY)));
        vm.expectRevert();
        factory.deploy(identity, 1, initial, _commitment(RECOVERY_NEXT), sig);
        vm.expectRevert();
        factory.deploy(identity, 1, initial, initial, sig);
        require(factory.predictAccount(identity, 1).code.length == 0, "tampered bootstrap deployed");
    }

    function testRecoveryRejectsHighSAndBootstrapCannotBeConsumedTwice() public {
        bytes memory signature = _seedSignature();
        bytes32 r;
        bytes32 lowS;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            lowS := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory malleable =
            abi.encodePacked(r, bytes32(order - uint256(lowS)), uint8(v == 27 ? 28 : 27));
        vm.expectRevert();
        _recoverSeed(malleable);
        vm.prank(address(module));
        vm.expectRevert();
        factory.consumeBootstrap(address(account));
        _unchanged();
        _recoverSeed(signature);
        _generationOne();
    }
}
