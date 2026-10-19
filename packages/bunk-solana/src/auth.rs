use solana_program::{
    account_info::AccountInfo,
    ed25519_program,
    hash::hashv,
    instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};

/// The message excludes the transport blockhash and payer. Length prefixes make
/// the instruction bytes and ordered action account keys unambiguous.
pub fn digest(
    program: &Pubkey,
    wallet: &Pubkey,
    network: &[u8; 32],
    data: &[u8],
    action_keys: &[Pubkey],
) -> [u8; 32] {
    let keys: Vec<u8> = action_keys.iter().flat_map(|k| k.to_bytes()).collect();
    hashv(&[
        b"HoneyBunkSolanaV1",
        program.as_ref(),
        wallet.as_ref(),
        network,
        &(data.len() as u32).to_le_bytes(),
        data,
        &(action_keys.len() as u16).to_le_bytes(),
        &keys,
    ])
    .to_bytes()
}
pub fn commitment(key: &Pubkey) -> [u8; 32] {
    hashv(&[key.as_ref()]).to_bytes()
}

pub fn verify(
    program: &Pubkey,
    instructions: &AccountInfo,
    expected: &[u8; 32],
    message: &[u8; 32],
) -> Result<(), ProgramError> {
    if get_stack_height() != TRANSACTION_LEVEL_STACK_HEIGHT {
        return Err(ProgramError::InvalidInstructionData);
    }
    let index = load_current_index_checked(instructions)?;
    if index == 0
        || load_instruction_at_checked(index as usize, instructions)?.program_id != *program
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let proof = load_instruction_at_checked(index as usize - 1, instructions)?;
    // Exactly one canonical, inline signature: key[16..48], signature[48..112],
    // 32-byte message[112..144]. No aliases, trailing bytes or external offsets.
    let header = [
        1, 0, 48, 0, 255, 255, 16, 0, 255, 255, 112, 0, 32, 0, 255, 255,
    ];
    if proof.program_id != ed25519_program::id()
        || !proof.accounts.is_empty()
        || proof.data.len() != 144
        || proof.data[..16] != header
        || proof.data[112..] != *message
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let key = Pubkey::new_from_array(
        proof.data[16..48]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    if commitment(&key) != *expected {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // The transaction runtime verified this precompile. Never replace it with a
    // host stub or disabled signature verification in runtime acceptance tests.
    Ok(())
}
