//! Adversarial runtime test helper, never part of a release deployment.
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
};
solana_program::entrypoint!(process);
fn process(_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target, forwarded) = accounts
        .split_last()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;
    let metas = forwarded
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(*a.key, a.is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, a.is_signer)
            }
        })
        .collect();
    invoke(
        &Instruction {
            program_id: *target.key,
            accounts: metas,
            data: data.to_vec(),
        },
        accounts,
    )
}
