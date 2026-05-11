// update_event_close: extend (or shorten) the `closes_at` timestamp on
// an existing EventHandle. Authority-only — same operator who created
// the event must sign.
//
// Use case: a session was registered with a short `closes_at` (e.g.
// 24h after start) but the broadcast / live event keeps running well
// past that. Without this ix, downstream constraints that compare
// against `event_handle.closes_at` (commit_lp_capital,
// commit_lp_capital_blind, settle_batch) would reject every subsequent
// flow on a stale handle.
//
// Sanity bound: `new_closes_at` must be strictly in the future. We do
// NOT cap the maximum — operators may legitimately set a multi-month
// window for long-running events.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::EventHandle;

#[derive(Accounts)]
pub struct UpdateEventClose<'info> {
    #[account(
        mut,
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
    )]
    pub event_handle: Account<'info, EventHandle>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateEventClose>, new_closes_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(new_closes_at > now, PredacyError::InvalidEventTiming);

    let event = &mut ctx.accounts.event_handle;
    let prev = event.closes_at;
    event.closes_at = new_closes_at;

    msg!(
        "[EventHandle] update_event_close prev={} new={} delta={}s",
        prev,
        new_closes_at,
        new_closes_at - prev,
    );

    Ok(())
}
