// accrue_maker_credit: relayer-attested credit assignment. Called once per
// (batch, maker) tuple where the maker's limit order absorbed taker flow
// at clearing time. Caller must be the EventHandle authority — only the
// relayer decides credit amounts (and is auditable via emitted msg).
//
// Relayer also separately transfers `fee_bps_rebates` of the batch's
// taker fees into the pool's USDC ATA via vanilla SPL transfer (no ix
// needed). The on-chain pool just tracks the credit ledger; payouts at
// claim time read the live token-account balance.
//
// init_if_needed on MakerCredit: first credit per maker creates the PDA;
// subsequent credits top it up. Re-init-attack guarded via PDA seeds
// (deterministic per maker) + `claimed` flag.
//
// See docs/LIQUIDITY.md §5.3.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, MakerCredit, MakerRebatePool};

#[derive(Accounts)]
#[instruction(maker: Pubkey)]
pub struct AccrueMakerCredit<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        mut,
        seeds = [MAKER_REBATE_POOL_SEED, event_handle.key().as_ref()],
        bump = rebate_pool.bump,
        constraint = rebate_pool.event_handle == event_handle.key() @ PredacyError::Unauthorized,
        constraint = !rebate_pool.closed @ PredacyError::EventClosed,
    )]
    pub rebate_pool: Account<'info, MakerRebatePool>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + MakerCredit::INIT_SPACE,
        seeds = [MAKER_CREDIT_SEED, rebate_pool.key().as_ref(), maker.as_ref()],
        bump,
    )]
    pub maker_credit: Account<'info, MakerCredit>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AccrueMakerCredit>, maker: Pubkey, credit: u64) -> Result<()> {
    require!(credit > 0, PredacyError::InsufficientBalance);

    // Cache before mutable borrow.
    let pool_key = ctx.accounts.rebate_pool.key();
    let credit_bump = ctx.bumps.maker_credit;

    let credit_account = &mut ctx.accounts.maker_credit;
    let is_new = credit_account.maker == Pubkey::default();
    if is_new {
        credit_account.pool = pool_key;
        credit_account.maker = maker;
        credit_account.bump = credit_bump;
    } else {
        // Re-init protection: existing claimed credits cannot be topped up.
        require!(!credit_account.claimed, PredacyError::AlreadyClaimed);
        // PDA already binds maker; this require! pins it for cheap auditing.
        require!(credit_account.maker == maker, PredacyError::Unauthorized);
    }

    credit_account.credit = credit_account
        .credit
        .checked_add(credit)
        .ok_or(PredacyError::Overflow)?;

    let pool = &mut ctx.accounts.rebate_pool;
    pool.total_credits = pool
        .total_credits
        .checked_add(credit)
        .ok_or(PredacyError::Overflow)?;

    msg!(
        "[RebatePool] accrue maker={} credit_delta={} maker_total={} pool_total={}",
        maker,
        credit,
        credit_account.credit,
        pool.total_credits,
    );

    Ok(())
}
