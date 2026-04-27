// commit_lp_capital_blind: Tier 1 Blind LP deposit. Same shape as
// commit_lp_capital but additionally writes a 32-byte Encrypt ciphertext
// public key into `LPPosition.fhe_shares_ct`. This ciphertext is created
// off-chain by the relayer via Encrypt's gRPC `CreateInput` ix BEFORE this
// tx fires; we just persist the id here.
//
// Privacy properties (v1):
//   - The ciphertext stored on-chain is genuinely encrypted under
//     Encrypt's network key. Anyone reading the chain sees opaque bytes.
//   - The plaintext USDC amount is still public on-chain (it has to be —
//     it's an SPL token transfer). What's hidden is the LP's ALLOCATION
//     CIPHERTEXT — useful when later versions of this ix run share-math
//     entirely in the encrypted domain (Encrypt Alpha 1).
//   - Per-batch settlement still operates on the plaintext aggregate
//     `vault.total_capital_usdc`, so vault-level state is public; only
//     per-LP positions become private.
//
// Decryption authority (v1): the relayer holds Encrypt's network key, so
// it can decrypt any ciphertext via the existing batch-clearing flow.
// Same trust model Encrypt's batch clearing uses today. Alpha 1 swaps
// this for LP-self-authenticated decryption via gRPC ReadCiphertext —
// no on-chain layout change since this ix already stores the ciphertext
// id in the same `fhe_shares_ct` field.
//
// See docs/LIQUIDITY.md §7 + relayer/scripts/test-fhe-blind-lp-feasibility.ts.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, LPPosition, LPVault};

#[derive(Accounts)]
pub struct CommitLpCapitalBlind<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + LPVault::INIT_SPACE,
        seeds = [LP_VAULT_SEED, event_handle.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, LPVault>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + LPPosition::INIT_SPACE,
        seeds = [LP_POSITION_SEED, vault.key().as_ref(), depositor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, LPPosition>,

    #[account(mut)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CommitLpCapitalBlind>,
    amount: u64,
    commitment_expires_at: i64,
    fhe_ciphertext_id: [u8; 32],
) -> Result<()> {
    require!(amount > 0, PredacyError::InsufficientBalance);

    let now = Clock::get()?.unix_timestamp;
    require!(commitment_expires_at > now, PredacyError::InvalidEventTiming);
    require!(
        commitment_expires_at <= ctx.accounts.event_handle.closes_at,
        PredacyError::InvalidEventTiming
    );

    // Pull USDC depositor → vault (plaintext, public — same as
    // commit_lp_capital. Privacy applies to the ALLOCATION ciphertext, not
    // the deposit transfer).
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.depositor_usdc.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    // Cache before mutable borrow of vault.
    let event_handle_key = ctx.accounts.event_handle.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let position_bump = ctx.bumps.position;
    let depositor_key = ctx.accounts.depositor.key();

    let vault = &mut ctx.accounts.vault;
    if vault.total_capital_usdc == 0 && vault.total_shares == 0 {
        vault.event_handle = event_handle_key;
        vault.bump = vault_bump;
        vault.fhe_encrypted_state = Vec::new();
    }

    let new_shares = if vault.total_shares == 0 {
        amount
    } else {
        amount
            .checked_mul(vault.total_shares)
            .ok_or(PredacyError::Overflow)?
            .checked_div(vault.total_capital_usdc.max(1))
            .ok_or(PredacyError::Overflow)?
    };
    require!(new_shares > 0, PredacyError::InsufficientBalance);

    vault.total_capital_usdc = vault
        .total_capital_usdc
        .checked_add(amount)
        .ok_or(PredacyError::Overflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_add(new_shares)
        .ok_or(PredacyError::Overflow)?;

    let position = &mut ctx.accounts.position;
    let is_new = position.depositor == Pubkey::default();
    if is_new {
        position.vault = vault_key;
        position.depositor = depositor_key;
        position.deposited_at = now;
        position.commitment_expires_at = commitment_expires_at;
        position.bump = position_bump;
    } else {
        require!(!position.withdrawn, PredacyError::AlreadyClaimed);
        position.commitment_expires_at = position
            .commitment_expires_at
            .max(commitment_expires_at);
    }

    // Plaintext share + USDC bookkeeping (same as commit_lp_capital — kept
    // so the vault NAV math at withdraw works without FHE arithmetic in v1).
    position.shares_plaintext = position
        .shares_plaintext
        .checked_add(new_shares)
        .ok_or(PredacyError::Overflow)?;
    position.deposited_usdc = position
        .deposited_usdc
        .checked_add(amount)
        .ok_or(PredacyError::Overflow)?;

    // The actually-novel bit: store the Encrypt ciphertext id. This is the
    // 32-byte on-chain artifact that represents the LP's encrypted balance.
    // Future ix that runs FHE share-math reads from here.
    position.fhe_shares_ct = fhe_ciphertext_id.to_vec();

    msg!(
        "[LPVault.Blind] commit depositor={} amount_usdc={} ct_prefix={:02x}{:02x}{:02x}{:02x} expires_at={}",
        depositor_key,
        amount,
        fhe_ciphertext_id[0],
        fhe_ciphertext_id[1],
        fhe_ciphertext_id[2],
        fhe_ciphertext_id[3],
        commitment_expires_at,
    );

    Ok(())
}
