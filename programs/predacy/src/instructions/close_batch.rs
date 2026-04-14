use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::BatchClosed;
use crate::state::{Batch, BatchStatus, Market, ProtocolConfig};

#[derive(Accounts)]
pub struct CloseBatch<'info> {
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [BATCH_SEED, &batch.market_id, &batch.batch_index.to_le_bytes()],
        bump = batch.bump,
        constraint = batch.market_id == market.market_id @ PredacyError::BatchMarketMismatch,
    )]
    pub batch: Account<'info, Batch>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<CloseBatch>) -> Result<()> {
    let clock = Clock::get()?;
    let batch = &mut ctx.accounts.batch;
    let config = &ctx.accounts.protocol_config;

    // Verify batch is open
    require!(batch.status() == BatchStatus::Open, PredacyError::InvalidBatchStatus);

    // Verify batch window has elapsed
    require!(
        clock.unix_timestamp - batch.opened_at >= config.batch_window_secs as i64,
        PredacyError::BatchWindowNotElapsed,
    );

    batch.status = BatchStatus::Settling as u8;
    batch.closed_at = clock.unix_timestamp;

    emit!(BatchClosed {
        batch_index: batch.batch_index,
        commitment_count: batch.commitment_count,
        closed_at: batch.closed_at,
    });

    Ok(())
}
