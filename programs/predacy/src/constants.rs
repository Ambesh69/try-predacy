use anchor_lang::prelude::*;

#[constant]
pub const PROTOCOL_SEED: &[u8] = b"protocol";
#[constant]
pub const MARKET_SEED: &[u8] = b"market";
#[constant]
pub const BATCH_SEED: &[u8] = b"batch";
#[constant]
pub const COMMITMENTS_SEED: &[u8] = b"commitments";
#[constant]
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
#[constant]
pub const YES_MINT_SEED: &[u8] = b"yes_mint";
#[constant]
pub const NO_MINT_SEED: &[u8] = b"no_mint";
#[constant]
pub const USDC_VAULT_SEED: &[u8] = b"usdc_vault";
#[constant]
pub const YES_VAULT_SEED: &[u8] = b"yes_vault";
#[constant]
pub const NO_VAULT_SEED: &[u8] = b"no_vault";
#[constant]
pub const EVENT_HANDLE_SEED: &[u8] = b"event";

pub const PRICE_DECIMALS: u64 = 1_000_000;
pub const DEFAULT_BATCH_WINDOW: u64 = 30;
pub const DEFAULT_MAX_ORDERS: u16 = 500;
pub const MAX_COMMITMENTS: usize = 64; // fits in 10KB init (64 * 40 = 2560 bytes + headers)
pub const RESCUE_DELAY: i64 = 7 * 24 * 60 * 60; // 7 days in seconds
pub const TOKEN_DECIMALS: u8 = 6;
