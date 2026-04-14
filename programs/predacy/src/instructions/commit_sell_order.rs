use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::OrderCommitted;
use crate::state::{Batch, BatchStatus, CommitmentStore, Market, OrderSide, ProtocolConfig};

#[derive(Accounts)]
pub struct CommitSellOrder<'info> {
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

    /// User's outcome token account (YES or NO tokens being sold)
    #[account(mut)]
    pub user_token_account: Box<Account<'info, TokenAccount>>,

    /// Market's YES or NO vault (destination for escrowed sell tokens)
    #[account(mut)]
    pub token_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<CommitSellOrder>,
    commitment_hash: [u8; 32],
    amount: u64,
    side: u8,
) -> Result<()> {
    let clock = Clock::get()?;
    let batch = &mut ctx.accounts.batch;
    let config = &ctx.accounts.protocol_config;
    let market = &ctx.accounts.market;

    // Verify batch is open
    require!(batch.status() == BatchStatus::Open, PredacyError::InvalidBatchStatus);

    // Verify batch window
    require!(
        clock.unix_timestamp - batch.opened_at < config.batch_window_secs as i64,
        PredacyError::BatchWindowElapsed,
    );

    // Verify side is a sell side
    let order_side = OrderSide::from_u8(side).ok_or(PredacyError::InvalidOrderSide)?;
    require!(!order_side.is_buy(), PredacyError::InvalidOrderSide);

    // Verify correct vault based on side
    if order_side.is_yes() {
        require!(ctx.accounts.token_vault.key() == market.yes_vault, PredacyError::InvalidOrderSide);
    } else {
        require!(ctx.accounts.token_vault.key() == market.no_vault, PredacyError::InvalidOrderSide);
    }

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

    // Transfer outcome tokens from user to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.token_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Update batch totals
    if order_side.is_yes() {
        batch.total_sell_yes = batch.total_sell_yes.checked_add(amount)
            .ok_or(PredacyError::Overflow)?;
    } else {
        batch.total_sell_no = batch.total_sell_no.checked_add(amount)
            .ok_or(PredacyError::Overflow)?;
    }
    batch.commitment_count += 1;

    emit!(OrderCommitted {
        batch_index: batch.batch_index,
        commitment_hash,
        commitment_index,
        amount,
    });

    Ok(())
}
