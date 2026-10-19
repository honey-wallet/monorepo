// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
pragma solidity 0.8.28;

import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IAccountExecute} from "account-abstraction/interfaces/IAccountExecute.sol";
import {
    RecoveryIntentAccount as Account,
    RecoveryIntentFactory as Factory
} from "./RecoveryIntentAccount.sol";
import {BunkPaymaster} from "../../src/BunkPaymaster.sol";
import {BunkModule} from "../../src/BunkModule.sol";
import {Vm, Target} from "../BunkIntegration.t.sol";

contract RecoveryIntentTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER = 0x1111;
    uint256 private constant NEXT = 0x2222;
    uint256 private constant ENVELOPE = 0x3333;
    uint256 private constant SPONSOR = 0x4444;
    EntryPoint private ep;
    Account private account;
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
        account = new Account(address(ep), _commitment(OWNER));
        target = new Target();
        vm.deal(address(account), 10 ether);
        vm.deal(address(this), 20 ether);
        paymaster = new BunkPaymaster(
            ep, BunkModule(address(account)), vm.addr(SPONSOR), 0.1 ether, address(this)
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
                keccak256("HoneyBunkRecoveryExperiment"),
                keccak256("0"),
                block.chainid,
                c.account
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                hex"1901", domain, keccak256(abi.encode(account.CERTIFICATE_TYPEHASH(), c))
            )
        );
        if (c.account == address(account)) {
            require(digest == account.certificateDigest(c), "typed hash drift");
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
            account.ownerIndex() == 0 && ep.getNonce(address(account), 0) == 0,
            "rejection consumed owner"
        );
    }

    function _consumedOnce() private {
        require(ownerSignatures == 1, "owner signed more than once");
        require(
            account.ownerIndex() == 1 && account.commitment() == _commitment(NEXT),
            "rotation failed"
        );
        require(ep.getNonce(address(account), 0) == 1, "wrong nonce");
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
                logs[i].emitter == address(account)
                    && logs[i].topics[0] == keccak256("ExpiredActionSkipped(bytes32)")
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
        (bool authorized,) = account.reservation(ep.getUserOpHash(op));
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
        Factory factory = new Factory(address(ep));
        bytes32 initial = _commitment(OWNER);
        bytes32 salt = bytes32(uint256(7));
        address predicted = factory.predict(initial, salt);
        PackedUserOperation memory op = _op();
        op.sender = predicted;
        op.initCode =
            abi.encodePacked(address(factory), abi.encodeCall(Factory.create, (initial, salt)));
        Account.Certificate memory c = _certificate(op);
        bytes memory ownerSig = _ownerApproval(c);
        op = _envelope(op, c, ownerSig);
        factory.create(initial, salt); // External first-deployment relay wins the race.
        account = Account(payable(predicted));
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
        op = _envelope(op, c, _sign(NEXT, account.certificateDigest(c)));
        _submit(op);
        require(target.value() == 42 && account.ownerIndex() == 2, "recovery stranded successor");
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
}
