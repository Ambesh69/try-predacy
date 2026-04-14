use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{Batch, BatchStatus, CommitmentStore, Market, OrderSide};

#[derive(Accounts)]
pub struct ClaimPosition<'info> {
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

    /// Claimer's token/USDC account for payout
    #[account(mut)]
    pub claimer_account: Box<Account<'info, TokenAccount>>,

    pub claimer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<ClaimPosition>,
    commitment_index: u16,
    side: u8,
    amount: u64,
    limit_price: u64,
    salt: [u8; 32],
) -> Result<()> {
    let batch = &mut ctx.accounts.batch;
    let market = &ctx.accounts.market;

    // Verify batch is SETTLED
    require!(batch.status() == BatchStatus::Settled, PredacyError::InvalidBatchStatus);

    // Verify not already claimed
    require!(!batch.is_claimed(commitment_index), PredacyError::AlreadyClaimed);

    // Recompute commitment hash from preimage
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

    // Verify against stored commitment
    let store = ctx.accounts.commitment_store.load()?;
    require!(
        store.commitments[commitment_index as usize].hash == computed_hash,
        PredacyError::CommitmentMismatch,
    );

    // Mark as claimed
    batch.mark_claimed(commitment_index);

    // Compute fill result
    let fills = if order_side.is_buy() {
        if order_side.is_yes() {
            limit_price >= batch.clearing_price
        } else {
            let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
            limit_price >= no_price
        }
    } else {
        if order_side.is_yes() {
            limit_price <= batch.clearing_price
        } else {
            let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
            limit_price <= no_price
        }
    };

    let market_id = market.market_id;
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &market_id, &bump]];

    if fills {
        match order_side {
            OrderSide::YesBuy => {
                let yes_tokens = amount
                    .checked_mul(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?
                    .checked_div(batch.clearing_price).ok_or(PredacyError::Overflow)?;
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.yes_vault.to_account_info(),
                            to: ctx.accounts.claimer_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    yes_tokens,
                )?;
            }
            OrderSide::NoBuy => {
                let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
                let no_tokens = amount
                    .checked_mul(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?
                    .checked_div(no_price).ok_or(PredacyError::Overflow)?;
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.no_vault.to_account_info(),
                            to: ctx.accounts.claimer_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    no_tokens,
                )?;
            }
            OrderSide::YesSell => {
                let usdc_payout = amount
                    .checked_mul(batch.clearing_price).ok_or(PredacyError::Overflow)?
                    .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?;
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
                    usdc_payout,
                )?;
            }
            OrderSide::NoSell => {
                let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
                let usdc_payout = amount
                    .checked_mul(no_price).ok_or(PredacyError::Overflow)?
                    .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?;
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
                    usdc_payout,
                )?;
            }
        }
    } else if !order_side.is_buy() {
        // Unfilled SELL: refund escrowed tokens
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
    // Unfilled BUY: USDC was escrowed at commit time — needs refund
    // (In Polygon, EIP-3009 deferred pull meant no deposit for unfilled BUY.
    //  On Solana, USDC is escrowed, so we refund.)
    else {
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
    }

    Ok(())
}
