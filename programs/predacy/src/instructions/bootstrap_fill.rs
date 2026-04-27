// bootstrap_fill: relayer-attested fill against the Tier 0 LMSR curve.
// Called by the relayer at batch close when retail demand on one side
// exceeds the other AND the event hasn't graduated to Tier 1 yet. The
// price is computed off-chain by `bootstrapCurve.ts` (LS-LMSR pricer) and
// passed in here; on-chain we update curve state + emit an event so the
// off-chain accountant can reconcile.
//
// Conservation: this ix does NOT move USDC or share tokens. The actual
// settlement still flows through `lock_funds` which mints/burns vault
// tokens against the clearing price. bootstrap_fill is a pure-state
// attestation — it tells the chain "the bootstrap pool absorbed N shares
// of side S at price P during this batch", and lock_funds reads the
// resulting `realized_pnl` delta when computing fee splits.
//
// Authority: only the EventHandle authority (i.e. the relayer) may call
// this. Random users can't manipulate Tier 0 state.
//
// See docs/LIQUIDITY.md §5.1 + §6 for the full design.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{BootstrapPool, EventHandle, OrderSide};

#[derive(Accounts)]
pub struct BootstrapFill<'info> {
    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        mut,
        seeds = [BOOTSTRAP_POOL_SEED, &bootstrap_pool.market_id],
        bump = bootstrap_pool.bump,
        constraint = bootstrap_pool.event_handle == event_handle.key() @ PredacyError::Unauthorized,
    )]
    pub bootstrap_pool: Account<'info, BootstrapPool>,

    pub authority: Signer<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<BootstrapFill>,
    side: u8,
    qty_shares: u64,        // 6-decimal shares the pool issued
    usdc_paid: u64,         // 6-decimal USDC the pool received (buy) or paid out (sell)
    is_buy: bool,           // true = pool sold shares to user; false = pool bought shares from user
) -> Result<()> {
    let pool = &mut ctx.accounts.bootstrap_pool;

    require!(!pool.graduated, PredacyError::InvalidBatchStatus);
    require!(qty_shares > 0, PredacyError::InsufficientBalance);

    // Validate side is YES_BUY/YES_SELL (treat as YES side) or NO_BUY/NO_SELL (NO side).
    // For curve accounting we collapse buy/sell into a directional share delta.
    let order_side =
        OrderSide::from_u8(side).ok_or(PredacyError::InvalidOrderSide)?;
    let is_yes_side = order_side.is_yes();

    // Sanity cap: a single fill cannot exceed 25% of current_q. Stops a
    // miscomputed off-chain price from draining the pool in one batch.
    // 25% chosen as a working ceiling — refine after live data.
    let max_single_fill = pool
        .current_q
        .checked_mul(2_500)
        .ok_or(PredacyError::Overflow)?
        .checked_div(10_000)
        .ok_or(PredacyError::Overflow)?;
    require!(usdc_paid <= max_single_fill, PredacyError::InsufficientBalance);

    // Update share state: pool issues shares to retail when is_buy=true,
    // burns/redeems when is_buy=false (sell-side residual).
    if is_buy {
        if is_yes_side {
            pool.yes_shares = pool
                .yes_shares
                .checked_add(qty_shares)
                .ok_or(PredacyError::Overflow)?;
        } else {
            pool.no_shares = pool
                .no_shares
                .checked_add(qty_shares)
                .ok_or(PredacyError::Overflow)?;
        }
        pool.current_q = pool
            .current_q
            .checked_add(usdc_paid)
            .ok_or(PredacyError::Overflow)?;
    } else {
        // Pool is buying back shares from a residual seller — shares burn,
        // collateral leaves the pool.
        if is_yes_side {
            pool.yes_shares = pool
                .yes_shares
                .checked_sub(qty_shares)
                .ok_or(PredacyError::InsufficientBalance)?;
        } else {
            pool.no_shares = pool
                .no_shares
                .checked_sub(qty_shares)
                .ok_or(PredacyError::InsufficientBalance)?;
        }
        pool.current_q = pool
            .current_q
            .checked_sub(usdc_paid)
            .ok_or(PredacyError::InsufficientBalance)?;
    }

    // Recompute b after Q changes — keeps the curve's liquidity-sensitivity
    // accurate for the next fill. b = α × Q with α = LMSR_ALPHA_BPS / 10_000.
    pool.b_param = pool
        .current_q
        .checked_mul(LMSR_ALPHA_BPS)
        .ok_or(PredacyError::Overflow)?
        .checked_div(10_000)
        .ok_or(PredacyError::Overflow)?;

    msg!(
        "[BootstrapFill] side={} qty={} usdc={} is_buy={} new_q={} new_b={} yes_sh={} no_sh={}",
        side,
        qty_shares,
        usdc_paid,
        is_buy,
        pool.current_q,
        pool.b_param,
        pool.yes_shares,
        pool.no_shares,
    );

    Ok(())
}

/// Operator can mark a pool graduated once Tier 1 capital is sufficient.
/// After this, bootstrap_fill rejects all calls. Reversible via the same
/// authority if Tier 1 capacity unexpectedly drops back below threshold —
/// keeps the safety net available.
pub fn set_graduated_handler(ctx: Context<BootstrapFill>, graduated: bool) -> Result<()> {
    let pool = &mut ctx.accounts.bootstrap_pool;
    pool.graduated = graduated;
    msg!(
        "[BootstrapPool] graduated={} for market_prefix={:02x}{:02x}{:02x}{:02x}",
        graduated,
        pool.market_id[0],
        pool.market_id[1],
        pool.market_id[2],
        pool.market_id[3],
    );
    Ok(())
}
