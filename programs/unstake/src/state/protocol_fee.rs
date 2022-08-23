use anchor_lang::prelude::Pubkey;

use anchor_lang::prelude::*;

use crate::{errors::UnstakeError, rational::Rational};

pub const PROTOCOL_FEE_SEED: &[u8] = b"protocol-fee";

/// Global singleton containing protocol fee parameters
#[account]
pub struct ProtocolFee {
    /// Protocol-owned account to receive the protocol fees to
    pub destination: Pubkey,

    /// Signer that is authorized to modify this account
    pub authority: Pubkey,

    /// The proportion of unstake fees that go to the protocol
    pub fee_ratio: Rational,

    /// The proprtion of the protocol fees that go to the referrer
    pub referrer_fee_ratio: Rational,
}

mod default_destination {
    use anchor_lang::declare_id;

    // devnet upgrade authority's non-ATA wSOL account
    #[cfg(feature = "local-testing")]
    declare_id!("J6T4Cwe5PkiRidMJMap4f8EBd5kiQ6JrrwF5XsXzFy8t");

    // Socean DAO's wSOL token account
    #[cfg(not(feature = "local-testing"))]
    declare_id!("3Gdk8hMa76JF8p5jonMP7vYPZuXRTJDtLmysYabB6WEE");
}

mod default_authority {
    use anchor_lang::declare_id;

    // devnet upgrade authority
    #[cfg(feature = "local-testing")]
    declare_id!("2NB9TSbKzqEHY9kUuTpnjS3VrsZhEooAWADLHe3WeL3E");

    // LEFT CURVE DAO's unstake program upgrade authority
    #[cfg(not(feature = "local-testing"))]
    declare_id!("4e3CRid3ugjAFRjSnmbbLie1CaeU41CBYhk4saKQgwBB");
}

impl Default for ProtocolFee {
    fn default() -> Self {
        Self {
            destination: default_destination::id(),
            authority: default_authority::id(),
            // 10%
            fee_ratio: Rational { num: 1, denom: 10 },
            // 50%
            referrer_fee_ratio: Rational { num: 1, denom: 2 },
        }
    }
}

impl ProtocolFee {
    pub fn validate(&self) -> Result<()> {
        if !self.fee_ratio.validate()
            || !self.fee_ratio.is_lte_one()
            || !self.referrer_fee_ratio.validate()
            || !self.referrer_fee_ratio.is_lte_one()
        {
            return Err(UnstakeError::InvalidFee.into());
        }

        Ok(())
    }

    /// Levies the protocol fee on a given fee amount
    ///
    /// Returns the number of lamports to be levied as the protocol fee
    /// and to subtract from `fee_lamports`
    ///
    /// Invariants:
    /// - return <= `fee_lamports`
    pub fn levy(&self, fee_lamports: u64) -> Option<u64> {
        self.fee_ratio.floor_mul(fee_lamports)
    }
}
