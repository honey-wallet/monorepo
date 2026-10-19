//! Candidate Solana Bunk protocol. No deployment ID or production activation is
//! supplied here. A trusted release must pin the program and upgrade policy.
pub mod auth;
pub mod state;

/// Release-pinned cluster identity, never selected by an initialization caller.
/// A release must use a distinct, trusted program deployment on each cluster.
pub const NETWORK: &[u8; 32] = include_bytes!(concat!(env!("OUT_DIR"), "/genesis.bin"));

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::{instruction as system_instruction, program as system_program};
use state::{spent_address, wallet_address, Reader, State, MAX_INDEX, SPENT_MAGIC, STATE_LEN};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[derive(Clone, Copy, Debug)]
#[repr(u32)]
pub enum Error {
    InvalidAuthority = 1,
    UsedKey,
    WrongState,
    Expired,
    InvalidAction,
    Overflow,
}
impl From<Error> for ProgramError {
    fn from(e: Error) -> Self {
        Self::Custom(e as u32)
    }
}
fn ensure(value: bool, error: Error) -> ProgramResult {
    if value {
        Ok(())
    } else {
        Err(error.into())
    }
}

fn common(accounts: &[AccountInfo], controls: usize) -> ProgramResult {
    if accounts.len() < controls {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    ensure(
        accounts[0].is_writable && accounts[1].is_writable && accounts[1].is_signer,
        Error::InvalidAuthority,
    )?;
    ensure(
        *accounts[2].key == solana_program::sysvar::instructions::id()
            && *accounts[3].key == system_program::id()
            && accounts[3].executable,
        Error::WrongState,
    )?;
    for i in 0..controls {
        for j in 0..i {
            ensure(accounts[i].key != accounts[j].key, Error::InvalidAction)?;
        }
    }
    Ok(())
}
fn no_owner_payer(payer: &Pubkey, state: &State) -> ProgramResult {
    let key = auth::commitment(payer);
    ensure(
        key != state.owner && key != state.recovery && key != auth::commitment(&state.identity),
        Error::InvalidAuthority,
    )
}
fn unused(
    program: &Pubkey,
    wallet: &Pubkey,
    key: &[u8; 32],
    account: &AccountInfo,
) -> ProgramResult {
    ensure(
        *account.key == spent_address(program, wallet, key).0,
        Error::WrongState,
    )?;
    ensure(
        *account.owner == system_program::id() && account.data_is_empty() && !account.executable,
        Error::UsedKey,
    )
}
fn successor(state: &State, key: &[u8; 32]) -> ProgramResult {
    ensure(
        *key != [0; 32]
            && *key != state.owner
            && *key != state.recovery
            && *key != auth::commitment(&state.identity),
        Error::UsedKey,
    )
}
fn create_pda<'a>(
    program: &Pubkey,
    account: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    size: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    ensure(
        account.is_writable
            && *account.owner == system_program::id()
            && account.data_is_empty()
            && !account.executable,
        Error::WrongState,
    )?;
    let rent = Rent::get()?.minimum_balance(size);
    let missing = rent.saturating_sub(account.lamports());
    if missing != 0 {
        invoke_signed(
            &system_instruction::transfer(payer.key, account.key, missing),
            &[payer.clone(), account.clone(), system.clone()],
            &[],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(account.key, size as u64),
        &[account.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, program),
        &[account.clone(), system.clone()],
        &[seeds],
    )
}
fn consume<'a>(
    program: &Pubkey,
    wallet: &Pubkey,
    key: &[u8; 32],
    account: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
) -> ProgramResult {
    unused(program, wallet, key, account)?;
    let bump = [spent_address(program, wallet, key).1];
    create_pda(
        program,
        account,
        payer,
        system,
        SPENT_MAGIC.len(),
        &[b"spent-v1", wallet.as_ref(), key, &bump],
    )?;
    account.try_borrow_mut_data()?.copy_from_slice(SPENT_MAGIC);
    Ok(())
}
fn load(program: &Pubkey, wallet: &AccountInfo) -> Result<State, ProgramError> {
    ensure(
        wallet.owner == program && !wallet.executable,
        Error::WrongState,
    )?;
    let state = State::decode(&wallet.try_borrow_data()?)?;
    ensure(state.network == *NETWORK, Error::WrongState)?;
    let (address, bump) = wallet_address(program, &state.identity, state.account_index);
    ensure(
        *wallet.key == address && state.bump == bump,
        Error::WrongState,
    )?;
    Ok(state)
}
fn save(wallet: &AccountInfo, state: &State) -> ProgramResult {
    wallet
        .try_borrow_mut_data()?
        .copy_from_slice(&state.encode());
    Ok(())
}

pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Bounds also keep the canonical digest/account allocation bounded on SBF.
    ensure(
        data.len() <= 700 && accounts.len() <= 20,
        Error::InvalidAction,
    )?;
    let mut r = Reader(data);
    match r.byte()? {
        0 => initialize(program, accounts, data, r),
        1 => execute(program, accounts, data, r),
        2 => recover(program, accounts, data, r),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// [wallet,payer,instructions,system,initial-owner-unused,initial-recovery-unused]
fn initialize(program: &Pubkey, a: &[AccountInfo], data: &[u8], mut r: Reader) -> ProgramResult {
    common(a, 6)?;
    ensure(a.len() == 6, Error::InvalidAction)?;
    let network = r.bytes()?;
    let identity = Pubkey::new_from_array(r.bytes()?);
    let index = r.u32()?;
    let owner = r.bytes()?;
    let recovery = r.bytes()?;
    r.end()?;
    ensure(
        network == *NETWORK && identity != Pubkey::default() && index <= MAX_INDEX,
        Error::InvalidAuthority,
    )?;
    let (wallet, bump) = wallet_address(program, &identity, index);
    ensure(wallet == *a[0].key, Error::WrongState)?;
    let state = State {
        network,
        identity,
        account_index: index,
        epoch: 0,
        owner_index: 0,
        nonce: 0,
        owner,
        recovery,
        bump,
    };
    ensure(
        owner != [0; 32]
            && recovery != [0; 32]
            && owner != recovery
            && owner != auth::commitment(&identity)
            && recovery != auth::commitment(&identity),
        Error::InvalidAuthority,
    )?;
    no_owner_payer(a[1].key, &state)?;
    unused(program, &wallet, &owner, &a[4])?;
    unused(program, &wallet, &recovery, &a[5])?;
    auth::verify(
        program,
        &a[2],
        &auth::commitment(&identity),
        &auth::digest(program, &wallet, &network, data, &[]),
    )?;
    create_pda(
        program,
        &a[0],
        &a[1],
        &a[3],
        STATE_LEN,
        &[
            b"wallet-v1",
            identity.as_ref(),
            &index.to_le_bytes(),
            &[bump],
        ],
    )?;
    save(&a[0], &state)
}

enum Action {
    Native(u64),
    Cpi { flags: Vec<u8>, data: Vec<u8> },
}
// [wallet,payer,instructions,system,spent-owner,next-owner-unused,action accounts...]
fn execute(program: &Pubkey, a: &[AccountInfo], data: &[u8], mut r: Reader) -> ProgramResult {
    common(a, 6)?;
    let mut state = load(program, &a[0])?;
    no_owner_payer(a[1].key, &state)?;
    let epoch = r.u32()?;
    let index = r.u32()?;
    let nonce = r.u64()?;
    let valid_after = r.u64()?;
    let valid_until = r.u64()?;
    let next = r.bytes()?;
    ensure(
        epoch == state.epoch && index == state.owner_index && nonce == state.nonce,
        Error::WrongState,
    )?;
    let slot = Clock::get()?.slot;
    ensure(
        valid_until != 0
            && valid_after <= slot
            && slot <= valid_until
            && valid_after <= valid_until,
        Error::Expired,
    )?;
    successor(&state, &next)?;
    // Do not expose the next authority by making it sign this transport first.
    ensure(auth::commitment(a[1].key) != next, Error::InvalidAuthority)?;
    unused(program, a[0].key, &next, &a[5])?;
    let action = match r.byte()? {
        0 => {
            let amount = r.u64()?;
            ensure(
                amount != 0 && a.len() == 7 && a[6].is_writable,
                Error::InvalidAction,
            )?;
            ensure(
                a[..6].iter().all(|v| v.key != a[6].key),
                Error::InvalidAction,
            )?;
            Action::Native(amount)
        }
        1 => {
            let count = r.byte()? as usize;
            ensure(
                count > 0 && count <= 12 && a.len() == 7 + count,
                Error::InvalidAction,
            )?;
            ensure(
                a[6].executable
                    && *a[6].key != *program
                    && a[..6].iter().all(|v| v.key != a[6].key),
                Error::InvalidAction,
            )?;
            let mut flags = Vec::with_capacity(count);
            for (i, account) in a[7..].iter().enumerate() {
                let flag = r.byte()?;
                ensure(
                    flag <= 3 && (flag & 1 == 0 || account.is_writable),
                    Error::InvalidAction,
                )?;
                ensure(
                    a[1..7].iter().all(|v| v.key != account.key)
                        && a[7..7 + i].iter().all(|v| v.key != account.key),
                    Error::InvalidAction,
                )?;
                // Only the wallet PDA can be a CPI signer; its state is read-only
                // for downstream programs. Other privileges are exactly signed.
                if account.key == a[0].key {
                    ensure(flag == 2, Error::InvalidAction)?;
                } else {
                    ensure(flag & 2 == 0, Error::InvalidAction)?;
                }
                flags.push(flag);
            }
            let length = u16::from_le_bytes(r.bytes()?) as usize;
            ensure(length <= 512 && r.0.len() == length, Error::InvalidAction)?;
            let payload = r.0.to_vec();
            r.0 = &[];
            Action::Cpi {
                flags,
                data: payload,
            }
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    r.end()?;
    let keys: Vec<Pubkey> = a[6..].iter().map(|v| *v.key).collect();
    auth::verify(
        program,
        &a[2],
        &state.owner,
        &auth::digest(program, a[0].key, &state.network, data, &keys),
    )?;
    let next_index = state
        .owner_index
        .checked_add(1)
        .filter(|i| *i <= MAX_INDEX)
        .ok_or(Error::Overflow)?;
    let next_nonce = state.nonce.checked_add(1).ok_or(Error::Overflow)?;
    consume(program, a[0].key, &state.owner, &a[4], &a[1], &a[3])?;
    state.owner = next;
    state.owner_index = next_index;
    state.nonce = next_nonce;
    save(&a[0], &state)?;
    match action {
        Action::Native(amount) => {
            let remaining = a[0]
                .lamports()
                .checked_sub(amount)
                .ok_or(ProgramError::InsufficientFunds)?;
            ensure(
                remaining >= Rent::get()?.minimum_balance(STATE_LEN),
                Error::InvalidAction,
            )?;
            let destination = a[6].lamports().checked_add(amount).ok_or(Error::Overflow)?;
            **a[0].try_borrow_mut_lamports()? = remaining;
            **a[6].try_borrow_mut_lamports()? = destination;
            Ok(())
        }
        Action::Cpi { flags, data } => {
            let metas = a[7..]
                .iter()
                .zip(flags)
                .map(|(v, f)| {
                    if f & 1 != 0 {
                        AccountMeta::new(*v.key, f & 2 != 0)
                    } else {
                        AccountMeta::new_readonly(*v.key, f & 2 != 0)
                    }
                })
                .collect();
            invoke_signed(
                &Instruction {
                    program_id: *a[6].key,
                    accounts: metas,
                    data,
                },
                &a[6..],
                &[&[
                    b"wallet-v1",
                    state.identity.as_ref(),
                    &state.account_index.to_le_bytes(),
                    &[state.bump],
                ]],
            )
        }
    }
    // A failed action returns an error: Solana rolls back the rotation AND tombstone.
    // Only the identical authorization may be retried by the off-chain coordinator.
}

// [wallet,payer,instructions,system,spent-owner,spent-recovery,next-owner-unused,next-recovery-unused]
fn recover(program: &Pubkey, a: &[AccountInfo], data: &[u8], mut r: Reader) -> ProgramResult {
    common(a, 8)?;
    ensure(a.len() == 8, Error::InvalidAction)?;
    let mut state = load(program, &a[0])?;
    no_owner_payer(a[1].key, &state)?;
    let epoch = r.u32()?;
    let next_owner = r.bytes()?;
    let next_recovery = r.bytes()?;
    r.end()?;
    ensure(
        epoch == state.epoch && next_owner != next_recovery,
        Error::WrongState,
    )?;
    successor(&state, &next_owner)?;
    successor(&state, &next_recovery)?;
    let payer_key = auth::commitment(a[1].key);
    ensure(
        payer_key != next_owner && payer_key != next_recovery,
        Error::InvalidAuthority,
    )?;
    unused(program, a[0].key, &next_owner, &a[6])?;
    unused(program, a[0].key, &next_recovery, &a[7])?;
    // No ordinary index, nonce, deadline, current owner or action is in this fixed
    // recovery certificate, so normal advancement cannot invalidate it.
    auth::verify(
        program,
        &a[2],
        &state.recovery,
        &auth::digest(program, a[0].key, &state.network, data, &[]),
    )?;
    let next_epoch = state
        .epoch
        .checked_add(1)
        .filter(|e| *e <= MAX_INDEX)
        .ok_or(Error::Overflow)?;
    consume(program, a[0].key, &state.owner, &a[4], &a[1], &a[3])?;
    consume(program, a[0].key, &state.recovery, &a[5], &a[1], &a[3])?;
    state.epoch = next_epoch;
    state.owner_index = 0;
    state.owner = next_owner;
    state.recovery = next_recovery;
    // Preserve the ordinary nonce and all funds. There is no recovery refund/call.
    save(&a[0], &state)
}
