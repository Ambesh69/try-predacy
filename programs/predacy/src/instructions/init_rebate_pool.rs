// init_rebate_pool: operator stands up the per-EventHandle rebate pool
// before the first batch settles. Only one pool per event; rejects double-
// init via PDA collision. The pool's USDC token account is created
// separately (PDA-owned ATA) so anyone — relayer or external bridge —
// can deposit fees into it without an ix call.
//
// See docs/LIQUIDITY.md §5.3.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, MakerRebatePool};

#[derive(Accounts)]
pub struct InitRebatePool<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        init,
        payer = authority,
        space = 8 + MakerRebatePool::INIT_SPACE,
        seeds = [MAKER_REBATE_POOL_SEED, event_handle.key().as_ref()],
        bump,
    )]
    pub rebate_pool: Account<'info, MakerRebatePool>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitRebatePool>) -> Result<()> {
    let pool = &mut ctx.accounts.rebate_pool;
    pool.event_handle = ctx.accounts.event_handle.key();
    pool.accrued_taker_fees_usdc = 0;
    pool.total_credits = 0;
    pool.closed = false;
    pool.bump = ctx.bumps.rebate_pool;

    msg!(
        "[RebatePool] init for event_prefix={:02x}{:02x}{:02x}{:02x}",
        ctx.accounts.event_handle.handle_id[0],
        ctx.accounts.event_handle.handle_id[1],
        ctx.accounts.event_handle.handle_id[2],
        ctx.accounts.event_handle.handle_id[3],
    );

    Ok(())
}
