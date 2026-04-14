use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::ClaimProcessed;
use crate::state::{Batch, BatchStatus, Market, Nullifier, OrderSide};

#[derive(Accounts)]
#[instruction(nullifier_hash: [u8; 32])]
pub struct ClaimWithProof<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [BATCH_SEED, &batch.market_id, &batch.batch_index.to_le_bytes()],
        bump = batch.bump,
        constraint = batch.market_id == market.market_id @ PredacyError::BatchMarketMismatch,
    )]
    pub batch: Account<'info, Batch>,

    /// Nullifier PDA — init fails if already exists (double-claim prevention)
    #[account(
        init,
        payer = relayer,
        space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, &nullifier_hash],
        bump,
    )]
    pub nullifier: Account<'info, Nullifier>,

    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.yes_vault)]
    pub yes_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.no_vault)]
    pub no_vault: Box<Account<'info, TokenAccount>>,

    /// Recipient's token account for payout (can be any wallet — privacy)
    #[account(mut)]
    pub recipient_account: Box<Account<'info, TokenAccount>>,

    /// Relayer submits on behalf of trader (pays rent + fees)
    #[account(mut)]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ClaimWithProof>,
    nullifier_hash: [u8; 32],
    side: u8,
    filled_amount: u64,
    refund_amount: u64,
    // Groth16 claim proof
    _proof_a: [u8; 64],
    _proof_b: [u8; 128],
    _proof_c: [u8; 64],
) -> Result<()> {
    let batch = &ctx.accounts.batch;
    let market = &ctx.accounts.market;

    // Verify batch is SETTLED
    require!(batch.status() == BatchStatus::Settled, PredacyError::InvalidBatchStatus);

    let order_side = OrderSide::from_u8(side).ok_or(PredacyError::InvalidOrderSide)?;

    // TODO: Verify Groth16 claim proof
    // Production: verify proof against claim_merkle_root, nullifier, fill amounts
    // let public_inputs = vec![
    //     batch.claim_merkle_root,
    //     nullifier_hash,
    //     u64_to_be_bytes32(filled_amount),
    //     u64_to_be_bytes32(refund_amount),
    //     u64_to_be_bytes32(side as u64),
    //     u64_to_be_bytes32(batch.batch_index),
    // ];
    // let verifier = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &public_inputs, &CLAIM_VK)?;
    // require!(verifier.verify().is_ok(), PredacyError::ProofVerificationFailed);

    // Mark nullifier as used (init succeeded = first use)
    let nullifier = &mut ctx.accounts.nullifier;
    nullifier.bump = ctx.bumps.nullifier;

    // PDA signer for market vault transfers
    let market_id = market.market_id;
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &market_id, &bump]];

    // Execute payout based on side
    match order_side {
        OrderSide::YesBuy => {
            // Filled BUY: transfer YES tokens from vault to recipient
            if filled_amount > 0 {
                let yes_tokens = filled_amount
                    .checked_mul(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?
                    .checked_div(batch.clearing_price).ok_or(PredacyError::Overflow)?;
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.yes_vault.to_account_info(),
                            to: ctx.accounts.recipient_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    yes_tokens,
                )?;
            }
        }
        OrderSide::NoBuy => {
            if filled_amount > 0 {
                let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
                let no_tokens = filled_amount
                    .checked_mul(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?
                    .checked_div(no_price).ok_or(PredacyError::Overflow)?;
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.no_vault.to_account_info(),
                            to: ctx.accounts.recipient_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    no_tokens,
                )?;
            }
        }
        OrderSide::YesSell => {
            // Filled SELL: transfer USDC proceeds from vault to recipient
            if filled_amount > 0 {
                let usdc_payout = filled_amount
                    .checked_mul(batch.clearing_price).ok_or(PredacyError::Overflow)?
                    .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?;
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.usdc_vault.to_account_info(),
                            to: ctx.accounts.recipient_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    usdc_payout,
                )?;
            }
            // Unfilled SELL: refund tokens
            if refund_amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.yes_vault.to_account_info(),
                            to: ctx.accounts.recipient_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    refund_amount,
                )?;
            }
        }
        OrderSide::NoSell => {
            if filled_amount > 0 {
                let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
                let usdc_payout = filled_amount
                    .checked_mul(no_price).ok_or(PredacyError::Overflow)?
                    .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?;
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.usdc_vault.to_account_info(),
                            to: ctx.accounts.recipient_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    usdc_payout,
                )?;
            }
            if refund_amount > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.key(),
                        Transfer {
                            from: ctx.accounts.no_vault.to_account_info(),
                            to: ctx.accounts.recipient_account.to_account_info(),
                            authority: ctx.accounts.market.to_account_info(),
                        },
                        signer_seeds,
                    ),
                    refund_amount,
                )?;
            }
        }
    }

    emit!(ClaimProcessed {
        batch_index: batch.batch_index,
        nullifier: nullifier_hash,
        side,
        filled_amount,
        refund_amount,
    });

    Ok(())
}
