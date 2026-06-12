//! TEST-ONLY mock oracle. Writes a `PriceUpdateV2` feed account whose layout matches the
//! real MagicBlock/Pyth feed and whose `feed_id == the account's own pubkey` (SHEAR's
//! convention). Lets the SHEAR trade/liquidation paths run on a local validator without the
//! real MagicBlock oracle. NOT for mainnet.

use anchor_lang::prelude::*;

declare_id!("EW4Mn9ysh1M18q28kamsJhqoQMZG7TjTTjT78wW3YxVB");

#[program]
pub mod mock_oracle {
    use super::*;

    /// Create-or-update a feed PDA `[b"feed", symbol]` with a price. publish_time = now (fresh).
    pub fn set_price(ctx: Context<SetPrice>, _symbol: [u8; 8], price: i64, conf: u64, expo: i32) -> Result<()> {
        let clock = Clock::get()?;
        let key = ctx.accounts.feed.key();
        let f = &mut ctx.accounts.feed;
        f.write_authority = ctx.accounts.payer.key();
        f.verification_level = VerificationLevel::Full;
        f.price_message = PriceFeedMessage {
            feed_id: key.to_bytes(),
            price,
            conf,
            exponent: expo,
            publish_time: clock.unix_timestamp,
            prev_publish_time: clock.unix_timestamp,
            ema_price: price,
            ema_conf: conf,
        };
        f.posted_slot = clock.slot;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
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

// Name MUST be `PriceUpdateV2` so the Anchor account discriminator matches what SHEAR's
// `try_deserialize_unchecked` reads, and the body layout matches the vendored reader.
#[account]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 8])]
pub struct SetPrice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + 32 + 2 + (32 + 8 + 8 + 4 + 8 + 8 + 8 + 8) + 8,
        seeds = [b"feed", symbol.as_ref()],
        bump
    )]
    pub feed: Account<'info, PriceUpdateV2>,
    pub system_program: Program<'info, System>,
}
