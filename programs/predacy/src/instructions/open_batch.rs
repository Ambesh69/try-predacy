use anchor_lang::prelude::*;

use crate::constants::*;
use crate::events::BatchOpened;
use crate::state::{Batch, CommitmentStore, Market, ProtocolConfig};

#[derive(Accounts)]
pub struct OpenBatch<'info> {
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + Batch::INIT_SPACE,
        seeds = [BATCH_SEED, &market.market_id, &market.current_batch_index.to_le_bytes()],
        bump,
    )]
    pub batch: Account<'info, Batch>,

    #[account(
        init,
        payer = authority,
        space = std::mem::size_of::<CommitmentStore>() + 8,
        seeds = [COMMITMENTS_SEED, &market.market_id, &market.current_batch_index.to_le_bytes()],
        bump,
    )]
    pub commitment_store: AccountLoader<'info, CommitmentStore>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<OpenBatch>) -> Result<()> {
    let clock = Clock::get()?;
    let market = &mut ctx.accounts.market;
    let batch = &mut ctx.accounts.batch;

    batch.market_id = market.market_id;
    batch.batch_index = market.current_batch_index;
    batch.status = 0; // BatchStatus::Open
    batch.opened_at = clock.unix_timestamp;
    batch.closed_at = 0;
    batch.total_deposited = 0;
    batch.total_sell_yes = 0;
    batch.total_sell_no = 0;
    batch.clearing_price = 0;
    batch.commitment_count = 0;
    batch.commitment_root = [0u8; 32];
    batch.claim_merkle_root = [0u8; 32];
    batch.filled_yes_buy_vol = 0;
    batch.filled_no_buy_vol = 0;
    batch.filled_yes_sell_qty = 0;
    batch.filled_no_sell_qty = 0;
    batch.yes_gap = 0;
    batch.no_gap = 0;
    batch.final_excess_yes = 0;
    batch.final_excess_no = 0;
    batch.claimed_bitmap = 0;
    batch.bump = ctx.bumps.batch;

    // Initialize commitment store
    let store = &mut ctx.accounts.commitment_store.load_init()?;
    store.count = 0;

    market.current_batch_index += 1;

    emit!(BatchOpened {
        market_id: market.market_id,
        batch_index: batch.batch_index,
        opened_at: batch.opened_at,
    });

    Ok(())
}
