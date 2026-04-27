// withdraw_lp_capital: an LP redeems their position after the commitment
// expires. Payout = pro-rata share of the vault's current USDC balance,
// computed as:
//
//     payout = position.shares × vault_usdc_balance / vault.total_shares
//
// The vault may currently hold less than `total_capital_usdc` if it took
// directional exposure that's still open (positions held to resolution),
// or more than `total_capital_usdc` if rebates have accrued. Either way,
// pro-rata against the actual USDC balance is correct: every LP shares
// the same NAV at withdraw time.
//
// Authority: anyone can crank a withdraw after `commitment_expires_at`,
// but the payout always goes to `position.depositor`. The "anyone can
// crank" rule lets a relayer auto-refund LPs without their interaction.
//
// See docs/LIQUIDITY.md §5.2.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, LPPosition, LPVault};

#[derive(Accounts)]
pub struct WithdrawLpCapital<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        mut,
        seeds = [LP_VAULT_SEED, event_handle.key().as_ref()],
        bump = vault.bump,
        constraint = vault.event_handle == event_handle.key() @ PredacyError::Unauthorized,
    )]
    pub vault: Account<'info, LPVault>,

    #[account(
        mut,
        seeds = [LP_POSITION_SEED, vault.key().as_ref(), position.depositor.as_ref()],
        bump = position.bump,
        constraint = position.vault == vault.key() @ PredacyError::Unauthorized,
        constraint = !position.withdrawn @ PredacyError::AlreadyClaimed,
    )]
    pub position: Account<'info, LPPosition>,

    /// Vault's USDC token account — the source of payout. PDA-owned by
    /// `vault` so we can sign the transfer with vault seeds.
    #[account(mut)]
    pub vault_usdc: Box<Account<'info, TokenAccount>>,

    /// Where the LP receives their USDC. Typically the depositor's ATA.
    #[account(mut)]
    pub depositor_usdc: Box<Account<'info, TokenAccount>>,

    /// Whoever is cranking this — could be the depositor themselves or a
    /// relayer-sponsored auto-refund. Pays the rent for any account
    /// closures (none in v1; future close=position).
    #[account(mut)]
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawLpCapital>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.position.commitment_expires_at,
        PredacyError::RescueDelayNotElapsed
    );

    let position = &mut ctx.accounts.position;
    let vault = &mut ctx.accounts.vault;

    require!(position.shares_plaintext > 0, PredacyError::InsufficientBalance);
    require!(vault.total_shares >= position.shares_plaintext, PredacyError::Overflow);

    // Pro-rata of current USDC balance.
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;
    let payout = (vault_usdc_balance as u128)
        .checked_mul(position.shares_plaintext as u128)
        .ok_or(PredacyError::Overflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(PredacyError::Overflow)? as u64;

    require!(payout > 0, PredacyError::InsufficientBalance);

    // Transfer USDC from vault → depositor. Vault is the PDA authority.
    let event_handle_key = ctx.accounts.event_handle.key();
    let vault_bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] =
        &[&[LP_VAULT_SEED, event_handle_key.as_ref(), &[vault_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault_usdc.to_account_info(),
                to: ctx.accounts.depositor_usdc.to_account_info(),
                authority: vault.to_account_info(),
            },
            signer_seeds,
        ),
        payout,
    )?;

    // Burn the LP's shares + reduce vault aggregates.
    vault.total_shares = vault
        .total_shares
        .checked_sub(position.shares_plaintext)
        .ok_or(PredacyError::Overflow)?;
    // total_capital_usdc tracks original deposit, decremented by the original
    // deposit amount (NOT the payout — payout reflects accrued P&L).
    vault.total_capital_usdc = vault
        .total_capital_usdc
        .saturating_sub(position.deposited_usdc);

    let burned_shares = position.shares_plaintext;
    position.shares_plaintext = 0;
    position.withdrawn = true;

    msg!(
        "[LPVault] withdraw depositor={} payout_usdc={} burned_shares={} remaining_shares={}",
        position.depositor,
        payout,
        burned_shares,
        vault.total_shares,
    );

    Ok(())
}
