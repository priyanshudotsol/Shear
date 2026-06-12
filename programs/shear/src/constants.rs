//! PDA seeds + fixed addresses (single source of truth; mirrors `state.md`).

use anchor_lang::prelude::*;

// v2 protocol — bound to Circle's devnet USDC. All seeds are suffixed "_uc" so the whole instance
// (config, vault, market, pool, balances, books) is fresh and independent of the prior custom-mint
// deployment. Old accounts are simply left behind.
pub const CONFIG_SEED: &[u8] = b"config_uc";
pub const MARKET_SEED: &[u8] = b"market_uc";
pub const POOL_SEED: &[u8] = b"pool_uc";
pub const LP_SEED: &[u8] = b"lp_uc";
pub const USER_SEED: &[u8] = b"user_uc";
pub const POSITION_SEED: &[u8] = b"posbook_uc";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth_uc";
pub const VAULT_SEED: &[u8] = b"vault_uc";
pub const SESSION_TOKEN_SEED: &[u8] = b"session_token_v2";

/// MagicBlock real-time pricing oracle program (magicblock-integration.md §5).
/// VERIFY feed accounts are owned by this before mainnet (§8 TODO #2).
pub const ORACLE_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");

/// Devnet faucet: amount of the program's USDC mint handed out per `faucet` call (10,000 USDC, 6dp).
pub const FAUCET_MINT_AMOUNT: u64 = 10_000_000_000;
/// Don't top up wallets already holding at least this much of the mint (50,000 USDC) — anti-spam.
pub const FAUCET_BALANCE_CAP: u64 = 50_000_000_000;
