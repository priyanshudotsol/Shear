//! Minimal vendored `PriceUpdateV2` reader (Path A — avoids the `pyth-solana-receiver-sdk`
//! anchor-version pin so we can stay on anchor-lang 1.0.2; see magicblock-integration.md §0/§5).
//!
//! The struct is named `PriceUpdateV2` ON PURPOSE: Anchor derives an account's 8-byte
//! discriminator from the struct NAME, so this matches the discriminator the real Pyth
//! receiver writes — `try_deserialize_unchecked` then borsh-decodes the body.
//!
//! ⚠️ VERIFY this field layout against `pyth-solana-receiver-sdk`'s `price_update.rs`
//!    before trusting it on real data. If the borsh layout of `VerificationLevel` bites,
//!    fall back to Path B/C and depend on the real crate instead.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

#[account]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

/// The subset of fields a consumer needs (mirrors pyth's `Price`).
pub struct Price {
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
}

impl PriceUpdateV2 {
    /// Returns the price iff the bound feed matches and it's within `max_age` seconds.
    pub fn get_price_no_older_than(
        &self,
        clock: &Clock,
        max_age: u64,
        feed_id: &[u8; 32],
    ) -> Result<Price> {
        // Use the program's single #[error_code] (Anchor allows only one per program).
        require!(&self.price_message.feed_id == feed_id, crate::error::ShearError::FeedMismatch);
        let age = clock.unix_timestamp.saturating_sub(self.price_message.publish_time);
        require!(age >= 0 && (age as u64) <= max_age, crate::error::ShearError::OracleStale);
        require!(self.price_message.price > 0, crate::error::ShearError::OracleStale);
        Ok(Price {
            price: self.price_message.price,
            conf: self.price_message.conf,
            exponent: self.price_message.exponent,
            publish_time: self.price_message.publish_time,
        })
    }
}
