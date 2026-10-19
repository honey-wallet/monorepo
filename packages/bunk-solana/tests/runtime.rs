//! Public fixture keys only. Executes the compiled SBF with real transaction and
//! Ed25519 precompile verification; no native processor/verification bypass.
use honey_bunk_solana::{
    auth,
    state::{spent_address, wallet_address, State, SPENT_MAGIC},
    NETWORK,
};
use litesvm::{types::FailedTransactionMetadata, LiteSVM};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use solana_system_interface::{instruction as system, program as system_program};

fn key(n: u8) -> Keypair {
    Keypair::new_from_array([n; 32])
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn independent_python_openssl_vectors_match_pda_encoding_digest_and_signatures() {
    let expected: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/v1.json")).unwrap();
    let mut f = Fixture::new();
    assert_eq!(hex(f.program.as_ref()), expected["program"]);
    assert_eq!(hex(f.wallet.as_ref()), expected["wallet"]);
    assert_eq!(hex(NETWORK), expected["network"]);
    assert_eq!(
        hex(spent_address(&f.program, &f.wallet, &root(2)).0.as_ref()),
        expected["spentOwner"]
    );
    let init = f.init_ix();
    let init_proof = f.proof(&init, 1, &[]);
    f.send(&[init_proof.clone(), init.clone()]).unwrap();
    assert_eq!(
        hex(&f.svm.get_account(&f.wallet).unwrap().data),
        expected["state"]
    );
    let native = f.native(2, 4, 1_000_000);
    let recover = f.recovery(3, 5, 6);
    for (i, ixs) in [[init_proof, init], native, recover].iter().enumerate() {
        assert_eq!(hex(&ixs[1].data), expected["vectors"][i]["instruction"]);
        assert_eq!(hex(&ixs[0].data), expected["vectors"][i]["precompile"]);
        assert_eq!(hex(&ixs[0].data[112..]), expected["vectors"][i]["digest"]);
    }
}

#[test]
fn compiled_wrapper_cannot_invoke_wallet_authorization_through_cpi() {
    let mut f = Fixture::new();
    let helper = key(239).pubkey();
    f.svm
        .add_program_from_file(
            helper,
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/deploy/honey_bunk_test_invoker.so"),
        )
        .unwrap();
    let mut ix = f.init_ix();
    let proof = f.proof(&ix, 1, &[]);
    ix.accounts
        .push(AccountMeta::new_readonly(f.program, false));
    ix.program_id = helper;
    f.assert_failed_unchanged(&[proof, ix]);
}
fn root(n: u8) -> [u8; 32] {
    auth::commitment(&key(n).pubkey())
}
struct Fixture {
    svm: LiteSVM,
    program: Pubkey,
    wallet: Pubkey,
    payer: Keypair,
    destination: Pubkey,
}
impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let program = key(240).pubkey();
        let artifact = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/deploy/honey_bunk_solana.so");
        svm.add_program_from_file(program, artifact)
            .expect("build SBF before runtime tests");
        let payer = key(241);
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let wallet = wallet_address(&program, &key(1).pubkey(), 7).0;
        Self {
            svm,
            program,
            wallet,
            payer,
            destination: key(242).pubkey(),
        }
    }
    fn controls(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(self.wallet, false),
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::sysvar::instructions::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ]
    }
    fn tomb(&self, commitment: [u8; 32], writable: bool) -> AccountMeta {
        let p = spent_address(&self.program, &self.wallet, &commitment).0;
        if writable {
            AccountMeta::new(p, false)
        } else {
            AccountMeta::new_readonly(p, false)
        }
    }
    fn state(&self) -> State {
        State::decode(&self.svm.get_account(&self.wallet).unwrap().data).unwrap()
    }
    fn proof(&self, ix: &Instruction, signer: u8, action_keys: &[Pubkey]) -> Instruction {
        let digest = auth::digest(&self.program, &self.wallet, NETWORK, &ix.data, action_keys);
        let signer = key(signer);
        let signature: [u8; 64] = signer.sign_message(&digest).as_ref().try_into().unwrap();
        solana_ed25519_program::new_ed25519_instruction_with_signature(
            &digest,
            &signature,
            &signer.pubkey().to_bytes(),
        )
    }
    fn send(&mut self, ixs: &[Instruction]) -> Result<(), Box<FailedTransactionMetadata>> {
        let tx = Transaction::new_signed_with_payer(
            ixs,
            Some(&self.payer.pubkey()),
            &[&self.payer],
            self.svm.latest_blockhash(),
        );
        assert!(
            bincode::serialized_size(&tx).unwrap() <= 1232,
            "legacy transaction exceeds packet budget"
        );
        self.svm.send_transaction(tx).map_err(Box::new).map(|meta| {
            assert!(meta.compute_units_consumed < 200_000);
        })
    }
    fn init_ix(&self) -> Instruction {
        let mut data = vec![0];
        data.extend_from_slice(NETWORK);
        data.extend_from_slice(key(1).pubkey().as_ref());
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&root(2));
        data.extend_from_slice(&root(3));
        let mut accounts = self.controls();
        accounts.push(self.tomb(root(2), false));
        accounts.push(self.tomb(root(3), false));
        Instruction {
            program_id: self.program,
            accounts,
            data,
        }
    }
    fn init(&mut self) {
        let ix = self.init_ix();
        let proof = self.proof(&ix, 1, &[]);
        self.send(&[proof, ix]).unwrap();
        self.svm.expire_blockhash();
    }
    fn fund(&mut self, amount: u64) {
        let ix = system::transfer(&self.payer.pubkey(), &self.wallet, amount);
        self.send(&[ix]).unwrap();
        self.svm.expire_blockhash();
    }
    fn execute_data(&self, next: u8) -> Vec<u8> {
        let s = self.state();
        let mut data = vec![1];
        data.extend_from_slice(&s.epoch.to_le_bytes());
        data.extend_from_slice(&s.owner_index.to_le_bytes());
        data.extend_from_slice(&s.nonce.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        data.extend_from_slice(&100u64.to_le_bytes());
        data.extend_from_slice(&root(next));
        data
    }
    fn execute_accounts(&self, next: u8) -> Vec<AccountMeta> {
        let mut accounts = self.controls();
        accounts.push(self.tomb(self.state().owner, true));
        accounts.push(self.tomb(root(next), false));
        accounts
    }
    fn native(&self, signer: u8, next: u8, amount: u64) -> [Instruction; 2] {
        let mut data = self.execute_data(next);
        data.push(0);
        data.extend_from_slice(&amount.to_le_bytes());
        let mut accounts = self.execute_accounts(next);
        accounts.push(AccountMeta::new(self.destination, false));
        let ix = Instruction {
            program_id: self.program,
            accounts,
            data,
        };
        [self.proof(&ix, signer, &[self.destination]), ix]
    }
    fn cpi(&self, signer: u8, next: u8, inner: Instruction) -> [Instruction; 2] {
        let mut data = self.execute_data(next);
        data.push(1);
        data.push(inner.accounts.len() as u8);
        let mut accounts = self.execute_accounts(next);
        accounts.push(AccountMeta::new_readonly(inner.program_id, false));
        let mut keys = vec![inner.program_id];
        for a in &inner.accounts {
            data.push(u8::from(a.is_writable) | (u8::from(a.is_signer) << 1));
            keys.push(a.pubkey);
            accounts.push(if a.is_writable {
                AccountMeta::new(a.pubkey, false)
            } else {
                AccountMeta::new_readonly(a.pubkey, false)
            });
        }
        data.extend_from_slice(&(inner.data.len() as u16).to_le_bytes());
        data.extend_from_slice(&inner.data);
        let ix = Instruction {
            program_id: self.program,
            accounts,
            data,
        };
        [self.proof(&ix, signer, &keys), ix]
    }
    fn recovery(&self, signer: u8, next: u8, next_recovery: u8) -> [Instruction; 2] {
        let s = self.state();
        let mut data = vec![2];
        data.extend_from_slice(&s.epoch.to_le_bytes());
        data.extend_from_slice(&root(next));
        data.extend_from_slice(&root(next_recovery));
        let mut accounts = self.controls();
        accounts.push(self.tomb(s.owner, true));
        accounts.push(self.tomb(s.recovery, true));
        accounts.push(self.tomb(root(next), false));
        accounts.push(self.tomb(root(next_recovery), false));
        let ix = Instruction {
            program_id: self.program,
            accounts,
            data,
        };
        [self.proof(&ix, signer, &[]), ix]
    }
    fn assert_failed_unchanged(&mut self, ixs: &[Instruction]) {
        let before = self.svm.get_account(&self.wallet);
        assert!(self.send(ixs).is_err());
        assert_eq!(self.svm.get_account(&self.wallet), before);
        self.svm.expire_blockhash();
    }
}

#[test]
fn prefunded_initialization_and_native_rotation_use_real_sbf() {
    let mut f = Fixture::new();
    f.fund(20_000_000);
    f.init();
    assert_eq!(f.svm.get_account(&f.wallet).unwrap().lamports, 20_000_000);
    assert_eq!(f.state().owner_index, 0);
    let ix = f.native(2, 4, 1_000_000);
    f.send(&ix).unwrap();
    let s = f.state();
    assert_eq!((s.epoch, s.owner_index, s.nonce), (0, 1, 1));
    assert_eq!(s.owner, root(4));
    assert_eq!(
        f.svm.get_account(&f.destination).unwrap().lamports,
        1_000_000
    );
    let spent = f
        .svm
        .get_account(&spent_address(&f.program, &f.wallet, &root(2)).0)
        .unwrap();
    assert_eq!(spent.owner, f.program);
    assert_eq!(spent.data, SPENT_MAGIC);
    f.svm.expire_blockhash();
    f.assert_failed_unchanged(&ix);
}

#[test]
fn initialization_requires_identity_network_pda_and_unique_authorities() {
    for mode in 0..6 {
        let mut f = Fixture::new();
        let mut ix = f.init_ix();
        match mode {
            0 => ix.data[1] ^= 1,
            1 => ix.accounts[0].pubkey = key(99).pubkey(),
            2 => ix.data[69..101].copy_from_slice(&root(3)),
            3 => ix.accounts[4].pubkey = key(99).pubkey(),
            4 => ix.data.push(0),
            _ => (),
        }
        let proof = f.proof(&ix, if mode == 5 { 99 } else { 1 }, &[]);
        f.assert_failed_unchanged(&[proof, ix]);
    }
    let mut f = Fixture::new();
    f.init();
    let ix = f.init_ix();
    let proof = f.proof(&ix, 1, &[]);
    f.assert_failed_unchanged(&[proof, ix]);
}

#[test]
fn forged_precompile_offsets_signatures_and_sysvars_do_not_authorize() {
    for mode in 0..5 {
        let mut f = Fixture::new();
        f.init();
        f.fund(10_000_000);
        let mut ixs = f.native(2, 4, 1_000_000);
        match mode {
            0 => ixs[0].data[48] ^= 1, // Runtime rejects a bad Ed25519 signature.
            1 => ixs[0].data[4..6].copy_from_slice(&0u16.to_le_bytes()), // Valid self reference, noncanonical encoding.
            2 => ixs[1].accounts[2].pubkey = key(99).pubkey(),
            3 => ixs[0] = f.proof(&ixs[1], 99, &[f.destination]),
            _ => {
                f.assert_failed_unchanged(&[ixs[1].clone()]);
                continue;
            }
        }
        f.assert_failed_unchanged(&ixs);
    }
}

#[test]
fn altered_action_fields_and_destination_fail_without_rotation() {
    for offset in [1, 5, 9, 25, 33, 66] {
        let mut f = Fixture::new();
        f.init();
        f.fund(10_000_000);
        let mut ixs = f.native(2, 4, 1_000_000);
        ixs[1].data[offset] ^= 1;
        f.assert_failed_unchanged(&ixs);
    }
    let mut f = Fixture::new();
    f.init();
    f.fund(10_000_000);
    let mut ixs = f.native(2, 4, 1_000_000);
    ixs[1].accounts[6].pubkey = key(98).pubkey();
    f.assert_failed_unchanged(&ixs);
}

#[test]
fn later_transaction_failure_rolls_back_rotation_and_identical_authorization_retries() {
    let mut f = Fixture::new();
    f.init();
    f.fund(10_000_000);
    let ixs = f.native(2, 4, 1_000_000);
    let fail = system::transfer(&f.payer.pubkey(), &f.destination, u64::MAX);
    f.assert_failed_unchanged(&[ixs[0].clone(), ixs[1].clone(), fail]);
    assert!(f
        .svm
        .get_account(&spent_address(&f.program, &f.wallet, &root(2)).0)
        .is_none());
    // No new owner signature; only the payer signs the changed transaction/blockhash.
    f.send(&ixs).unwrap();
    assert_eq!(f.state().owner, root(4));
}

#[test]
fn rent_floor_and_exhaustion_fail_atomically() {
    let mut f = Fixture::new();
    f.init();
    let ixs = f.native(2, 4, 1);
    f.assert_failed_unchanged(&ixs);
    for (index, nonce) in [(0x7fff_ffff, 0), (0, u64::MAX)] {
        // Explicit adversarial boundary fixture; normal flows do not write state directly.
        let mut account = f.svm.get_account(&f.wallet).unwrap();
        let mut s = f.state();
        s.owner_index = index;
        s.nonce = nonce;
        account.data = s.encode();
        f.svm.set_account(f.wallet, account).unwrap();
        f.fund(1_000_000);
        let ixs = f.native(2, 4, 1);
        f.assert_failed_unchanged(&ixs);
    }
}

#[test]
fn old_and_cross_role_keys_cannot_be_successors() {
    let mut f = Fixture::new();
    f.init();
    f.fund(10_000_000);
    for next in [1, 2, 3] {
        let ixs = f.native(2, next, 1);
        f.assert_failed_unchanged(&ixs);
    }
    let ixs = f.native(2, 4, 1);
    f.send(&ixs).unwrap();
    f.svm.expire_blockhash();
    let replay = f.native(4, 2, 1);
    f.assert_failed_unchanged(&replay);
    let cross = f.recovery(3, 2, 5);
    f.assert_failed_unchanged(&cross);
}

#[test]
fn fixed_recovery_survives_ordinary_advance_and_revokes_old_generation() {
    let mut f = Fixture::new();
    f.init();
    f.fund(10_000_000);
    let mut recovery = f.recovery(3, 5, 6);
    let exact_proof = recovery[0].data.clone();
    let action = f.native(2, 4, 1_000_000);
    f.send(&action).unwrap();
    f.svm.expire_blockhash();
    let mut stale = f.native(4, 7, 1_000_000);
    stale[1].data[25..33].copy_from_slice(&2000u64.to_le_bytes());
    stale[0] = f.proof(&stale[1], 4, &[f.destination]);
    recovery[1].accounts[4] = f.tomb(root(4), true);
    let funds = f.svm.get_account(&f.wallet).unwrap().lamports;
    f.svm.warp_to_slot(1000); // Recovery has no action expiry.
    f.send(&recovery).unwrap();
    assert_eq!(recovery[0].data, exact_proof);
    assert_eq!(f.svm.get_account(&f.wallet).unwrap().lamports, funds);
    let s = f.state();
    assert_eq!((s.epoch, s.owner_index, s.nonce), (1, 0, 1));
    assert_eq!((s.owner, s.recovery), (root(5), root(6)));
    for n in [2, 3, 4] {
        assert_eq!(
            f.svm
                .get_account(&spent_address(&f.program, &f.wallet, &root(n)).0)
                .unwrap()
                .data,
            SPENT_MAGIC
        );
    }
    f.svm.expire_blockhash();
    f.assert_failed_unchanged(&stale);
    f.assert_failed_unchanged(&recovery);
    let mut fresh = f.native(5, 7, 1);
    fresh[1].data[25..33].copy_from_slice(&2000u64.to_le_bytes());
    fresh[0] = f.proof(&fresh[1], 5, &[f.destination]);
    f.send(&fresh).unwrap();
    assert_eq!(f.state().nonce, 2);
}

#[test]
fn known_recovery_target_preemption_blocks_fixed_certificate() {
    // Characterization of an OPEN protocol blocker, not a security acceptance gate.
    // An exposed current owner only needs the public recovery target commitment;
    // it need not possess either incoming private key to preempt the reset.
    for incoming in [5, 6] {
        let mut f = Fixture::new();
        f.init();
        f.fund(10_000_000);
        let mut recovery = f.recovery(3, 5, 6);
        let exact_proof = recovery[0].data.clone();
        let preempt = f.native(2, incoming, 1);
        f.send(&preempt).unwrap();
        f.svm.expire_blockhash();
        recovery[1].accounts[4] = f.tomb(root(incoming), true);
        f.assert_failed_unchanged(&recovery);
        assert_eq!(recovery[0].data, exact_proof);
        assert_eq!((f.state().epoch, f.state().owner), (0, root(incoming)));
    }
}

#[test]
fn recovery_wrong_signer_successor_epoch_and_trailing_actions_fail() {
    for mode in 0..5 {
        let mut f = Fixture::new();
        f.init();
        let mut ixs = f.recovery(if mode == 0 { 2 } else { 3 }, 4, 5);
        match mode {
            1 => ixs[1].data[1] ^= 1,
            2 => ixs[1].data[5] ^= 1,
            3 => ixs[1].data.push(0),
            4 => ixs[1].accounts[6].pubkey = key(99).pubkey(),
            _ => (),
        }
        f.assert_failed_unchanged(&ixs);
    }
}

#[test]
fn expired_authorization_preserves_owner_until_independent_recovery() {
    let mut f = Fixture::new();
    f.init();
    f.fund(10_000_000);
    let action = f.native(2, 4, 1_000_000);
    f.svm.warp_to_slot(101);
    let error = f.send(&action).unwrap_err();
    assert_eq!(
        error.err,
        solana_sdk::transaction::TransactionError::InstructionError(
            1,
            solana_sdk::instruction::InstructionError::Custom(
                honey_bunk_solana::Error::Expired as u32
            )
        )
    );
    assert_eq!((f.state().owner, f.state().nonce), (root(2), 0));
    f.svm.expire_blockhash();
    let recovery = f.recovery(3, 5, 6);
    f.send(&recovery).unwrap();
    assert_eq!((f.state().epoch, f.state().owner), (1, root(5)));
}

#[test]
fn owner_or_recovery_key_cannot_be_used_as_transport_payer() {
    for n in [1, 2, 3] {
        let mut f = Fixture::new();
        f.payer = key(n);
        f.svm.airdrop(&f.payer.pubkey(), 1_000_000_000).unwrap();
        let ix = f.init_ix();
        let proof = f.proof(&ix, 1, &[]);
        f.assert_failed_unchanged(&[proof, ix]);
    }
}

#[test]
fn successor_authorities_cannot_be_transport_payers() {
    for payer in [4, 5, 6] {
        let mut f = Fixture::new();
        f.init();
        f.fund(10_000_000);
        f.payer = key(payer);
        f.svm.airdrop(&f.payer.pubkey(), 1_000_000_000).unwrap();
        let action = if payer == 4 {
            f.native(2, 4, 1)
        } else {
            f.recovery(3, 5, 6)
        };
        f.assert_failed_unchanged(&action);
    }
}

#[test]
fn forged_consumption_accounts_and_terminal_recovery_epoch_fail_atomically() {
    let mut f = Fixture::new();
    f.init();
    f.fund(10_000_000);
    let mut action = f.native(2, 4, 1);
    action[1].accounts[4].pubkey = key(98).pubkey();
    f.assert_failed_unchanged(&action);
    let mut recovery = f.recovery(3, 4, 5);
    recovery[1].accounts[5].pubkey = key(97).pubkey();
    f.assert_failed_unchanged(&recovery);
    // Boundary fixture only; the program cannot reach or wrap past this generation.
    let mut account = f.svm.get_account(&f.wallet).unwrap();
    let mut s = f.state();
    s.epoch = 0x7fff_ffff;
    account.data = s.encode();
    f.svm.set_account(f.wallet, account).unwrap();
    let recovery = f.recovery(3, 4, 5);
    f.assert_failed_unchanged(&recovery);
    assert!(f
        .svm
        .get_account(&spent_address(&f.program, &f.wallet, &root(2)).0)
        .is_none());
    assert!(f
        .svm
        .get_account(&spent_address(&f.program, &f.wallet, &root(3)).0)
        .is_none());
}

fn token_accounts(f: &mut Fixture) -> (Pubkey, Pubkey, Pubkey) {
    let mint = key(210);
    let source = key(211);
    let dest = key(212);
    let token = spl_token::id();
    let payer = f.payer.pubkey();
    let ixs = vec![
        system::create_account(
            &payer,
            &mint.pubkey(),
            f.svm
                .minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN),
            spl_token::state::Mint::LEN as u64,
            &token,
        ),
        spl_token::instruction::initialize_mint2(&token, &mint.pubkey(), &payer, None, 6).unwrap(),
        system::create_account(
            &payer,
            &source.pubkey(),
            f.svm
                .minimum_balance_for_rent_exemption(spl_token::state::Account::LEN),
            spl_token::state::Account::LEN as u64,
            &token,
        ),
        spl_token::instruction::initialize_account3(
            &token,
            &source.pubkey(),
            &mint.pubkey(),
            &f.wallet,
        )
        .unwrap(),
        system::create_account(
            &payer,
            &dest.pubkey(),
            f.svm
                .minimum_balance_for_rent_exemption(spl_token::state::Account::LEN),
            spl_token::state::Account::LEN as u64,
            &token,
        ),
        spl_token::instruction::initialize_account3(
            &token,
            &dest.pubkey(),
            &mint.pubkey(),
            &f.destination,
        )
        .unwrap(),
    ];
    let tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&payer),
        &[&f.payer, &mint, &source, &dest],
        f.svm.latest_blockhash(),
    );
    f.svm.send_transaction(tx).unwrap();
    f.svm.expire_blockhash();
    (mint.pubkey(), source.pubkey(), dest.pubkey())
}
#[test]
fn real_spl_cpi_failure_rolls_back_then_exact_authorization_succeeds_after_funding() {
    let mut f = Fixture::new();
    f.init();
    let (mint, source, dest) = token_accounts(&mut f);
    let inner = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        &source,
        &mint,
        &dest,
        &f.wallet,
        &[],
        50,
        6,
    )
    .unwrap();
    let ixs = f.cpi(2, 4, inner);
    f.assert_failed_unchanged(&ixs);
    assert!(f
        .svm
        .get_account(&spent_address(&f.program, &f.wallet, &root(2)).0)
        .is_none());
    let mint_ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        &mint,
        &source,
        &f.payer.pubkey(),
        &[],
        100,
    )
    .unwrap();
    f.send(&[mint_ix]).unwrap();
    f.svm.expire_blockhash();
    f.send(&ixs).unwrap();
    assert_eq!(f.state().owner_index, 1);
    assert_eq!(
        spl_token::state::Account::unpack(&f.svm.get_account(&dest).unwrap().data)
            .unwrap()
            .amount,
        50
    );
}
#[test]
fn cpi_rejects_self_call_writable_wallet_external_signers_and_duplicate_accounts() {
    let mut f = Fixture::new();
    f.init();
    for mode in 0..4 {
        let mut inner = Instruction {
            program_id: spl_token::id(),
            accounts: vec![AccountMeta::new_readonly(f.wallet, true)],
            data: vec![0],
        };
        match mode {
            0 => inner.program_id = f.program,
            1 => inner.accounts[0].is_writable = true,
            2 => inner.accounts[0].pubkey = key(99).pubkey(),
            3 => inner.accounts.push(inner.accounts[0].clone()),
            _ => (),
        }
        let ixs = f.cpi(2, 4, inner);
        f.assert_failed_unchanged(&ixs);
    }
}
