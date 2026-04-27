// init_bootstrap_pool: stand up a Tier 0 LS-LMSR pool for a specific
// market. Operator (EventHandle authority) calls this once after
// create_market and before the first batch needs cold-start liquidity.
//
// The seed_usdc value is taken from the EventHandle's `bootstrap_seed_usdc`
// field — a market doesn't get to override its parent event's seed. The
// caller must pre-fund the pool's USDC vault separately; this ix does NOT
// move tokens, only creates the bookkeeping PDA + sets initial curve state.
// Funding lives outside the ix because real seed flows from the protocol
// treasury account (set up in initialize.rs) and the operator triggers
// the SPL transfer in a separate ix in the same tx if desired.
//
// See docs/LIQUIDITY.md §5.1 for full design rationale.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{BootstrapPool, EventHandle, Market};

#[derive(Accounts)]
pub struct InitBootstrapPool<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        // Only the EventHandle authority (relayer / operator) can stand up
        // pools under their event. This keeps random users from seeding
        // bogus pools.
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        init,
        payer = authority,
        space = 8 + BootstrapPool::INIT_SPACE,
        seeds = [BOOTSTRAP_POOL_SEED, &market.market_id],
        bump,
    )]
    pub bootstrap_pool: Account<'info, BootstrapPool>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitBootstrapPool>) -> Result<()> {
    let event = &ctx.accounts.event_handle;
    let market = &ctx.accounts.market;

    let seed = event.bootstrap_seed_usdc;
    require!(seed > 0, PredacyError::InsufficientBalance);

    // b = (α / 10_000) × Q. With α = LMSR_ALPHA_BPS = 14_400 and Q = seed,
    // b ≈ 1.44 × seed. Worst-case loss for a binary market is b × ln(2) ≈ Q,
    // so a $100 seed bounds protocol loss at ~$100 per market — the cost of
    // running price discovery for this market until Tier 1 graduates in.
    let b_param = seed
        .checked_mul(LMSR_ALPHA_BPS)
        .ok_or(PredacyError::Overflow)?
        .checked_div(10_000)
        .ok_or(PredacyError::Overflow)?;

    let pool = &mut ctx.accounts.bootstrap_pool;
    pool.market_id = market.market_id;
    pool.event_handle = event.key();
    pool.seed_usdc = seed;
    pool.current_q = seed;
    pool.b_param = b_param;
    pool.yes_shares = 0;
    pool.no_shares = 0;
    pool.graduated = false;
    pool.realized_pnl = 0;
    pool.bump = ctx.bumps.bootstrap_pool;

    msg!(
        "[BootstrapPool] init market_id_prefix={:02x}{:02x}{:02x}{:02x} seed_usdc={} b_param={}",
        market.market_id[0],
        market.market_id[1],
        market.market_id[2],
        market.market_id[3],
        seed,
        b_param,
    );

    Ok(())
}
