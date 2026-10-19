use solana_program::{program_error::ProgramError, pubkey::Pubkey};

pub const MAX_INDEX: u32 = 0x7fff_ffff;
pub const STATE_LEN: usize = 157;
pub const MAGIC: &[u8; 8] = b"HNYBUNK1";
pub const SPENT_MAGIC: &[u8; 8] = b"HNYSPNT1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub network: [u8; 32],
    pub identity: Pubkey,
    pub account_index: u32,
    pub epoch: u32,
    pub owner_index: u32,
    pub nonce: u64,
    pub owner: [u8; 32],
    pub recovery: [u8; 32],
    pub bump: u8,
}

pub struct Reader<'a>(pub &'a [u8]);
impl Reader<'_> {
    pub fn bytes<const N: usize>(&mut self) -> Result<[u8; N], ProgramError> {
        let v = self
            .0
            .get(..N)
            .ok_or(ProgramError::InvalidInstructionData)?;
        let out = v
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        self.0 = &self.0[N..];
        Ok(out)
    }
    pub fn byte(&mut self) -> Result<u8, ProgramError> {
        Ok(self.bytes::<1>()?[0])
    }
    pub fn u32(&mut self) -> Result<u32, ProgramError> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }
    pub fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }
    pub fn end(&self) -> Result<(), ProgramError> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(ProgramError::InvalidInstructionData)
        }
    }
}
impl State {
    pub fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN || data.get(..8) != Some(MAGIC.as_slice()) {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut r = Reader(&data[8..]);
        let state = Self {
            network: r.bytes()?,
            identity: Pubkey::new_from_array(r.bytes()?),
            account_index: r.u32()?,
            epoch: r.u32()?,
            owner_index: r.u32()?,
            nonce: r.u64()?,
            owner: r.bytes()?,
            recovery: r.bytes()?,
            bump: r.byte()?,
        };
        if state.account_index > MAX_INDEX
            || state.epoch > MAX_INDEX
            || state.owner_index > MAX_INDEX
            || state.network == [0; 32]
            || state.identity == Pubkey::default()
            || state.owner == [0; 32]
            || state.recovery == [0; 32]
            || state.owner == state.recovery
        {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(state)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(STATE_LEN);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&self.network);
        out.extend_from_slice(self.identity.as_ref());
        out.extend_from_slice(&self.account_index.to_le_bytes());
        out.extend_from_slice(&self.epoch.to_le_bytes());
        out.extend_from_slice(&self.owner_index.to_le_bytes());
        out.extend_from_slice(&self.nonce.to_le_bytes());
        out.extend_from_slice(&self.owner);
        out.extend_from_slice(&self.recovery);
        out.push(self.bump);
        out
    }
}
pub fn wallet_address(program: &Pubkey, identity: &Pubkey, index: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"wallet-v1", identity.as_ref(), &index.to_le_bytes()],
        program,
    )
}
pub fn spent_address(program: &Pubkey, wallet: &Pubkey, commitment: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"spent-v1", wallet.as_ref(), commitment], program)
}
