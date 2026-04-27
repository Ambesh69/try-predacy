// lp_settle_batch: relayer-attested mutation of the LP vault's net
// inventory after a batch settles. Called once per settled batch under
// an EventHandle (post-graduation only — pre-graduation, residuals go
// to the Tier 0 BootstrapPool instead).
//
// Inputs are signed deltas (i64) so a single ix can record both
// directions: e.g. `delta_yes_position = +200` means the vault absorbed
// 200 YES tokens of net buy demand; `-200` means the vault sold 200 YES
// to the market (filling residual sell supply).
//
// Token movements still flow through `lock_funds` — this ix is pure
// state mutation. The relayer is responsible for ensuring the on-chain
// vault USDC balance and the off-chain math agree (auditable via the
// emitted msg).
//
// Authority: only the EventHandle's authority (relayer) may call.
//
// See docs/LIQUIDITY.md §5.2 + §6.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{EventHandle, LPVault};

#[derive(Accounts)]
pub struct LpSettleBatch<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        mut,
        seeds = [LP_VAULT_SEED, event_handle.key().as_ref()],
        bump = vault.bump,
        constraint = vault.event_handle == event_handle.key() @ PredacyError::Unauthorized,
    )]
    pub vault: Account<'info, LPVault>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<LpSettleBatch>,
    delta_yes_position: i64,    // 6-decimal share-units, signed
    delta_no_position: i64,
    rebate_share_usdc: u64,     // accumulated taker rebate this batch attributable to vault
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    // Apply signed deltas to net inventory.
    vault.realized_yes_position = vault
        .realized_yes_position
        .checked_add(delta_yes_position)
        .ok_or(PredacyError::Overflow)?;
    vault.realized_no_position = vault
        .realized_no_position
        .checked_add(delta_no_position)
        .ok_or(PredacyError::Overflow)?;

    vault.accumulated_rebates_usdc = vault
        .accumulated_rebates_usdc
        .checked_add(rebate_share_usdc)
        .ok_or(PredacyError::Overflow)?;

    msg!(
        "[LPVault] settle delta_yes={} delta_no={} rebate={} net_yes={} net_no={} cum_rebates={}",
        delta_yes_position,
        delta_no_position,
        rebate_share_usdc,
        vault.realized_yes_position,
        vault.realized_no_position,
        vault.accumulated_rebates_usdc,
    );

    Ok(())
}
