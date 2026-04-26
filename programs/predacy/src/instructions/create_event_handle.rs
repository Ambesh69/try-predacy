// create_event_handle: stand up a new EventHandle PDA that LPs can commit
// capital under and that downstream markets inherit fee/graduation params
// from. See docs/LIQUIDITY.md §4 for the full design rationale.
//
// Caller is the EventHandle authority (operator). Markets created against
// this handle later read the same authority for permissioning operator
// actions (closing event early, etc.). For v1 the authority is the relayer
// keypair; v2 may delegate to a multisig.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventCategory, EventHandle};

#[derive(Accounts)]
#[instruction(handle_id: [u8; 32])]
pub struct CreateEventHandle<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + EventHandle::INIT_SPACE,
        seeds = [EVENT_HANDLE_SEED, &handle_id],
        bump,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateEventHandle>,
    handle_id: [u8; 32],
    category: u8,
    closes_at: i64,
    graduation_threshold_usdc: u64,
    graduation_batches: u8,
    fee_bps_taker: u16,
    fee_bps_treasury: u16,
    fee_bps_rebates: u16,
    bootstrap_seed_usdc: u64,
) -> Result<()> {
    // Validate category is one of the known enum variants. Anything outside
    // 0..=4 risks downstream code branching on garbage values.
    require!(
        EventCategory::from_u8(category).is_some(),
        PredacyError::InvalidEventCategory
    );

    let now = Clock::get()?.unix_timestamp;
    require!(closes_at > now, PredacyError::InvalidEventTiming);

    // Enforce the fee split invariant up front so settlement-time math can
    // assume treasury + rebates exactly equals the taker bps.  If either
    // slice is wrong the protocol either over- or under-distributes fees.
    require!(
        fee_bps_treasury
            .checked_add(fee_bps_rebates)
            .ok_or(PredacyError::Overflow)?
            == fee_bps_taker,
        PredacyError::InvalidEventFees
    );

    let handle = &mut ctx.accounts.event_handle;
    handle.handle_id = handle_id;
    handle.category = category;
    handle.authority = ctx.accounts.authority.key();
    handle.created_at = now;
    handle.closes_at = closes_at;
    handle.graduation_threshold_usdc = graduation_threshold_usdc;
    handle.graduation_batches = graduation_batches;
    handle.fee_bps_taker = fee_bps_taker;
    handle.fee_bps_treasury = fee_bps_treasury;
    handle.fee_bps_rebates = fee_bps_rebates;
    handle.bootstrap_seed_usdc = bootstrap_seed_usdc;
    handle.closed = false;
    handle.bump = ctx.bumps.event_handle;

    // Compact hex for the handle prefix — full 32 bytes is too noisy in logs.
    msg!(
        "[EventHandle] created handle_id_prefix={:02x}{:02x}{:02x}{:02x} category={} closes_at={} fee_bps_taker={} bootstrap_seed_usdc={}",
        handle_id[0],
        handle_id[1],
        handle_id[2],
        handle_id[3],
        category,
        closes_at,
        fee_bps_taker,
        bootstrap_seed_usdc,
    );

    Ok(())
}
