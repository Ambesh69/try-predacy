use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{Batch, BatchStatus, CommitmentStore, Market, OrderSide};

#[derive(Accounts)]
pub struct RescueStuckOrder<'info> {
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
        seeds = [COMMITMENTS_SEED, &batch.market_id, &batch.batch_index.to_le_bytes()],
        bump,
    )]
    pub commitment_store: AccountLoader<'info, CommitmentStore>,

    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.yes_vault)]
    pub yes_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.no_vault)]
    pub no_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub claimer_account: Box<Account<'info, TokenAccount>>,

    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<RescueStuckOrder>,
    commitment_index: u16,
    side: u8,
    amount: u64,
    limit_price: u64,
    salt: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let batch = &mut ctx.accounts.batch;
    let market = &ctx.accounts.market;

    // Must be stuck in SETTLING (pre-lockFunds) for 7+ days
    require!(
        batch.status() == BatchStatus::Settling,
        PredacyError::InvalidBatchStatus,
    );
    require!(
        clock.unix_timestamp - batch.closed_at >= RESCUE_DELAY,
        PredacyError::RescueDelayNotElapsed,
    );

    // Verify not already claimed
    require!(!batch.is_claimed(commitment_index), PredacyError::AlreadyClaimed);

    // Verify commitment preimage
    let order_side = OrderSide::from_u8(side).ok_or(PredacyError::InvalidOrderSide)?;
    let preimage = [
        market.market_id.as_ref(),
        &[side],
        &amount.to_le_bytes(),
        &limit_price.to_le_bytes(),
        salt.as_ref(),
    ]
    .concat();
    let computed_hash = solana_program::keccak::hash(&preimage).to_bytes();

    let store = ctx.accounts.commitment_store.load()?;
    require!(
        store.commitments[commitment_index as usize].hash == computed_hash,
        PredacyError::CommitmentMismatch,
    );

    batch.mark_claimed(commitment_index);

    let market_id = market.market_id;
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &market_id, &bump]];

    // Return escrowed assets
    if order_side.is_buy() {
        // Refund USDC
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    to: ctx.accounts.claimer_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    } else {
        // Refund outcome tokens
        let vault = if order_side.is_yes() {
            ctx.accounts.yes_vault.to_account_info()
        } else {
            ctx.accounts.no_vault.to_account_info()
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: vault,
                    to: ctx.accounts.claimer_account.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;
    }

    Ok(())
}
