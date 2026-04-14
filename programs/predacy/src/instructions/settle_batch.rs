use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::BatchSettled;
use crate::state::{Batch, BatchStatus, Market};

#[derive(Accounts)]
pub struct SettleBatch<'info> {
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

    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.yes_vault)]
    pub yes_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = market.no_vault)]
    pub no_vault: Box<Account<'info, TokenAccount>>,

    /// Relayer returns gap tokens and USDC proceeds
    #[account(mut)]
    pub relayer_usdc: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub relayer_yes: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub relayer_no: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<SettleBatch>,
    claim_merkle_root: [u8; 32],
    // Groth16 proof components (for future ZK verification)
    _proof_a: [u8; 64],
    _proof_b: [u8; 128],
    _proof_c: [u8; 64],
) -> Result<()> {
    let batch = &mut ctx.accounts.batch;

    // Verify batch is LOCKED
    require!(batch.status() == BatchStatus::Locked, PredacyError::InvalidBatchStatus);

    // TODO: Verify Groth16 proof using groth16-solana crate
    // For hackathon MVP, we accept the proof as valid.
    // Production: uncomment and integrate groth16_solana::groth16::Groth16Verifier
    //
    // let public_inputs = vec![
    //     batch.commitment_root,
    //     u64_to_be_bytes32(batch.clearing_price),
    //     u64_to_be_bytes32(batch.filled_yes_buy_vol),
    //     u64_to_be_bytes32(batch.filled_no_buy_vol),
    //     u64_to_be_bytes32(batch.filled_yes_sell_qty),
    //     u64_to_be_bytes32(batch.filled_no_sell_qty),
    // ];
    // let verifier = Groth16Verifier::new(&proof_a, &proof_b, &proof_c, &public_inputs, &BATCH_VK)?;
    // require!(verifier.verify().is_ok(), PredacyError::ProofVerificationFailed);

    // Relayer returns gap YES tokens to vault
    if batch.yes_gap > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.relayer_yes.to_account_info(),
                    to: ctx.accounts.yes_vault.to_account_info(),
                    authority: ctx.accounts.relayer.to_account_info(),
                },
            ),
            batch.yes_gap,
        )?;
    }

    // Relayer returns gap NO tokens to vault
    if batch.no_gap > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.relayer_no.to_account_info(),
                    to: ctx.accounts.no_vault.to_account_info(),
                    authority: ctx.accounts.relayer.to_account_info(),
                },
            ),
            batch.no_gap,
        )?;
    }

    // Relayer returns USDC proceeds from excess token sales
    if batch.final_excess_yes > 0 || batch.final_excess_no > 0 {
        let excess_usdc_yes = batch.final_excess_yes
            .checked_mul(batch.clearing_price).ok_or(PredacyError::Overflow)?
            .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?;
        let no_price = PRICE_DECIMALS.checked_sub(batch.clearing_price).ok_or(PredacyError::Overflow)?;
        let excess_usdc_no = batch.final_excess_no
            .checked_mul(no_price).ok_or(PredacyError::Overflow)?
            .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?;
        let total_excess_usdc = excess_usdc_yes.checked_add(excess_usdc_no).ok_or(PredacyError::Overflow)?;

        if total_excess_usdc > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.relayer_usdc.to_account_info(),
                        to: ctx.accounts.usdc_vault.to_account_info(),
                        authority: ctx.accounts.relayer.to_account_info(),
                    },
                ),
                total_excess_usdc,
            )?;
        }
    }

    // Store claim Merkle root and finalize
    batch.claim_merkle_root = claim_merkle_root;
    batch.status = BatchStatus::Settled as u8;

    emit!(BatchSettled {
        batch_index: batch.batch_index,
        claim_merkle_root,
    });

    Ok(())
}
