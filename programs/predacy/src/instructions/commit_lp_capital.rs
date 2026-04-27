// commit_lp_capital: an LP deposits USDC under an EventHandle and receives
// virtual shares in the LP vault. Capital auto-refunds at the position's
// `commitment_expires_at` timestamp; before that, the vault uses the LP's
// proportional share of capital to absorb residual imbalance from each
// settled batch in markets under this event.
//
// Share calculation (plaintext v1):
//   first depositor:     shares = deposited_usdc           (1:1)
//   subsequent deposits: shares = deposited_usdc * total_shares / total_capital_usdc
//
// USDC moves from the depositor's token account into the vault's USDC
// vault PDA. The vault PDA is created lazily by the first depositor (see
// init_if_needed semantics — handled here as a require!).
//
// See docs/LIQUIDITY.md §5.2.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, LPPosition, LPVault};

#[derive(Accounts)]
pub struct CommitLpCapital<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    /// Vault PDA. The first call to commit_lp_capital under this event
    /// initialises it; subsequent calls just mutate state.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + LPVault::INIT_SPACE,
        seeds = [LP_VAULT_SEED, event_handle.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, LPVault>,

    /// Per-(vault, depositor) position PDA. Created on first deposit; reused
    /// on later top-ups within the same window. After withdraw, position
    /// can be re-initialised for a fresh commitment by closing it first.
    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + LPPosition::INIT_SPACE,
        seeds = [LP_POSITION_SEED, vault.key().as_ref(), depositor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, LPPosition>,

    /// Vault's USDC token account. Must be a PDA-owned ATA so the vault
    /// itself authorises payouts at withdraw time.
    #[account(mut)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// Depositor's USDC source account.
    #[account(mut)]
    pub depositor_usdc: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CommitLpCapital>,
    amount: u64,
    commitment_expires_at: i64,
) -> Result<()> {
    require!(amount > 0, PredacyError::InsufficientBalance);

    let now = Clock::get()?.unix_timestamp;
    require!(
        commitment_expires_at > now,
        PredacyError::InvalidEventTiming
    );
    // Position cannot outlast the parent event — capping here saves the
    // refund crank from chasing positions on closed events.
    require!(
        commitment_expires_at <= ctx.accounts.event_handle.closes_at,
        PredacyError::InvalidEventTiming
    );

    // Pull USDC from depositor → vault.
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

    // Cache key + bump before taking the mutable borrow on vault.
    let event_handle_key = ctx.accounts.event_handle.key();
    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let position_bump = ctx.bumps.position;

    let vault = &mut ctx.accounts.vault;

    // Initialise vault on first-ever deposit.
    if vault.total_capital_usdc == 0 && vault.total_shares == 0 {
        vault.event_handle = event_handle_key;
        vault.bump = vault_bump;
        vault.fhe_encrypted_state = Vec::new(); // populated in v2
    }

    // Share issuance: 1:1 for first depositor; pro-rata thereafter.
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

    let depositor_key = ctx.accounts.depositor.key();
    let position = &mut ctx.accounts.position;
    let is_new_position = position.depositor == Pubkey::default();
    if is_new_position {
        position.vault = vault_key;
        position.depositor = depositor_key;
        position.deposited_at = now;
        position.commitment_expires_at = commitment_expires_at;
        position.fhe_shares_ct = Vec::new(); // populated in v2
        position.bump = position_bump;
    } else {
        // Top-up on existing position: existing position cannot be already
        // withdrawn (or it'd be a fresh commitment), and the new expiry
        // can only extend, not shorten.
        require!(!position.withdrawn, PredacyError::AlreadyClaimed);
        position.commitment_expires_at = position
            .commitment_expires_at
            .max(commitment_expires_at);
    }

    position.shares_plaintext = position
        .shares_plaintext
        .checked_add(new_shares)
        .ok_or(PredacyError::Overflow)?;
    position.deposited_usdc = position
        .deposited_usdc
        .checked_add(amount)
        .ok_or(PredacyError::Overflow)?;

    msg!(
        "[LPVault] commit depositor={} amount_usdc={} shares_minted={} expires_at={}",
        depositor_key,
        amount,
        new_shares,
        commitment_expires_at,
    );

    Ok(())
}
