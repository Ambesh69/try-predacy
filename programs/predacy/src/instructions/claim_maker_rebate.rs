// claim_maker_rebate: maker withdraws their pro-rata share of the rebate
// pool after it's been closed (event ended). Payout = my_credit /
// total_credits × pool_usdc_balance. The pool's token account is
// PDA-owned; the pool itself signs the SPL transfer.
//
// `close_rebate_pool` must run before any claims. That ix is operator-
// gated; close-then-claim ordering protects against pool dilution from
// late accruals after some makers have already claimed.
//
// See docs/LIQUIDITY.md §5.3.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, MakerCredit, MakerRebatePool};

#[derive(Accounts)]
pub struct ClaimMakerRebate<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        seeds = [MAKER_REBATE_POOL_SEED, event_handle.key().as_ref()],
        bump = rebate_pool.bump,
        constraint = rebate_pool.event_handle == event_handle.key() @ PredacyError::Unauthorized,
        constraint = rebate_pool.closed @ PredacyError::InvalidBatchStatus,
    )]
    pub rebate_pool: Account<'info, MakerRebatePool>,

    #[account(
        mut,
        seeds = [MAKER_CREDIT_SEED, rebate_pool.key().as_ref(), maker.key().as_ref()],
        bump = maker_credit.bump,
        constraint = maker_credit.pool == rebate_pool.key() @ PredacyError::Unauthorized,
        constraint = maker_credit.maker == maker.key() @ PredacyError::Unauthorized,
        constraint = !maker_credit.claimed @ PredacyError::AlreadyClaimed,
    )]
    pub maker_credit: Account<'info, MakerCredit>,

    /// Pool's USDC token account. PDA-owned by `rebate_pool`.
    #[account(mut)]
    pub pool_usdc: Box<Account<'info, TokenAccount>>,

    /// Maker's USDC destination — typically their ATA.
    #[account(mut)]
    pub maker_usdc: Box<Account<'info, TokenAccount>>,

    pub maker: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimMakerRebate>) -> Result<()> {
    let pool = &ctx.accounts.rebate_pool;
    require!(pool.total_credits > 0, PredacyError::InsufficientBalance);

    let credit = ctx.accounts.maker_credit.credit;
    require!(credit > 0, PredacyError::InsufficientBalance);

    // payout = balance × credit / total_credits, computed in u128 to
    // avoid overflow at high TVL.
    let pool_balance = ctx.accounts.pool_usdc.amount;
    let payout = (pool_balance as u128)
        .checked_mul(credit as u128)
        .ok_or(PredacyError::Overflow)?
        .checked_div(pool.total_credits as u128)
        .ok_or(PredacyError::Overflow)? as u64;

    require!(payout > 0, PredacyError::InsufficientBalance);

    // Pool PDA signs.
    let event_key = ctx.accounts.event_handle.key();
    let pool_bump = pool.bump;
    let signer_seeds: &[&[&[u8]]] =
        &[&[MAKER_REBATE_POOL_SEED, event_key.as_ref(), &[pool_bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.pool_usdc.to_account_info(),
                to: ctx.accounts.maker_usdc.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer_seeds,
        ),
        payout,
    )?;

    let credit_account = &mut ctx.accounts.maker_credit;
    credit_account.claimed = true;

    msg!(
        "[RebatePool] claim maker={} credit={} payout_usdc={} pool_balance_post={}",
        ctx.accounts.maker.key(),
        credit,
        payout,
        pool_balance.saturating_sub(payout),
    );

    Ok(())
}

/// Close the pool — operator-only. After close, accrue_maker_credit
/// rejects further calls (event_handle.closed gate is the proxy here);
/// only claims remain valid.
#[derive(Accounts)]
pub struct CloseRebatePool<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        mut,
        seeds = [MAKER_REBATE_POOL_SEED, event_handle.key().as_ref()],
        bump = rebate_pool.bump,
    )]
    pub rebate_pool: Account<'info, MakerRebatePool>,

    pub authority: Signer<'info>,
}

pub fn close_handler(ctx: Context<CloseRebatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.rebate_pool;
    require!(!pool.closed, PredacyError::EventClosed);
    pool.closed = true;
    msg!(
        "[RebatePool] closed. total_credits={} accrued_fees={}",
        pool.total_credits,
        pool.accrued_taker_fees_usdc,
    );
    Ok(())
}

/// Operator-attested fee deposit log: when relayer transfers USDC into
/// the pool ATA off-chain, it should also call this to bump the
/// `accrued_taker_fees_usdc` counter for accurate UI display. Pure
/// bookkeeping; doesn't move tokens (the token transfer happens via
/// vanilla SPL transfer outside this ix).
#[derive(Accounts)]
pub struct LogRebateDeposit<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        mut,
        seeds = [MAKER_REBATE_POOL_SEED, event_handle.key().as_ref()],
        bump = rebate_pool.bump,
    )]
    pub rebate_pool: Account<'info, MakerRebatePool>,

    pub authority: Signer<'info>,
}

pub fn log_deposit_handler(ctx: Context<LogRebateDeposit>, amount: u64) -> Result<()> {
    let pool = &mut ctx.accounts.rebate_pool;
    pool.accrued_taker_fees_usdc = pool
        .accrued_taker_fees_usdc
        .checked_add(amount)
        .ok_or(PredacyError::Overflow)?;
    msg!(
        "[RebatePool] log_deposit amount_usdc={} cumulative={}",
        amount,
        pool.accrued_taker_fees_usdc,
    );
    Ok(())
}
