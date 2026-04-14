use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::OrderCommitted;
use crate::state::{Batch, BatchStatus, CommitmentStore, Market, ProtocolConfig};

#[derive(Accounts)]
pub struct CommitOrder<'info> {
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

    #[account(
        mut,
        seeds = [COMMITMENTS_SEED, &batch.market_id, &batch.batch_index.to_le_bytes()],
        bump,
    )]
    pub commitment_store: AccountLoader<'info, CommitmentStore>,

    /// User's USDC token account (source of escrow)
    #[account(
        mut,
        constraint = user_usdc_account.mint == protocol_config.usdc_mint,
    )]
    pub user_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Market's USDC vault (escrow destination)
    #[account(
        mut,
        address = market.usdc_vault,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<CommitOrder>,
    commitment_hash: [u8; 32],
    amount: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let batch = &mut ctx.accounts.batch;
    let config = &ctx.accounts.protocol_config;

    // Verify batch is open
    require!(batch.status() == BatchStatus::Open, PredacyError::InvalidBatchStatus);

    // Verify batch window hasn't elapsed
    require!(
        clock.unix_timestamp - batch.opened_at < config.batch_window_secs as i64,
        PredacyError::BatchWindowElapsed,
    );

    // Store commitment
    let mut store = ctx.accounts.commitment_store.load_mut()?;
    require!(
        (store.count as u16) < config.max_orders_per_batch,
        PredacyError::MaxOrdersReached,
    );

    let idx = store.count as usize;
    store.commitments[idx].hash = commitment_hash;
    store.commitments[idx].amount = amount;
    let commitment_index = store.count as u16;
    store.count += 1;
    drop(store);

    // Transfer USDC from user to vault (escrow)
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.user_usdc_account.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update batch totals (side is hidden — all BUY orders deposit USDC)
    batch.total_deposited = batch.total_deposited.checked_add(amount)
        .ok_or(PredacyError::Overflow)?;
    batch.commitment_count += 1;

    emit!(OrderCommitted {
        batch_index: batch.batch_index,
        commitment_hash,
        commitment_index,
        amount,
    });

    Ok(())
}
