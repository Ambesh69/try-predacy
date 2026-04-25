use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use groth16_solana::groth16::Groth16Verifier;

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::ClaimProcessed;
use crate::state::{Batch, BatchStatus, Market, Nullifier, OrderSide};
use crate::vkeys::CLAIM_VK;

/// Encode a u64 as a 32-byte big-endian array (BN254 field element).
#[inline(always)]
fn u64_to_be32(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

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
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    recipient_field: [u8; 32],
) -> Result<()> {
    let batch = &ctx.accounts.batch;
    let market = &ctx.accounts.market;

    // Verify batch is SETTLED
    require!(batch.status() == BatchStatus::Settled, PredacyError::InvalidBatchStatus);

    let order_side = OrderSide::from_u8(side).ok_or(PredacyError::InvalidOrderSide)?;

    // ─── Groth16 verification of the claim proof ───
    // Circuit's 9 public signals, in order (see circuits/claim/claim.circom):
    // Outputs come first in Circom's public-signal ordering, then inputs.
    //   OUTPUTS:
    //     1. fills       — 0 or 1, did the order fill
    //     2. fillAmount  — same u64 as instruction arg
    //     3. refundAmount — same u64 as instruction arg
    //     4. sideOut     — echoes the private `side` input
    //   INPUTS:
    //     5. batchId     — batch.batch_index
    //     6. claimMerkleRoot — batch.claim_merkle_root (Poseidon Merkle tree)
    //     7. clearingPrice   — batch.clearing_price
    //     8. nullifier   — same [u8;32] as instruction arg
    //     9. recipient   — field-element-encoded recipient pubkey (soft-binding)
    //
    // The circuit proves: (a) the order preimage was in the committed batch's
    // Merkle tree, (b) the nullifier is correctly derived from it, (c) the
    // fill/refund amounts are computed correctly at the clearing price.
    let fills: u64 = if filled_amount > 0 { 1 } else { 0 };
    let public_inputs: [[u8; 32]; 9] = [
        u64_to_be32(fills),
        u64_to_be32(filled_amount),
        u64_to_be32(refund_amount),
        u64_to_be32(side as u64),
        u64_to_be32(batch.batch_index),
        batch.claim_merkle_root,
        u64_to_be32(batch.clearing_price),
        nullifier_hash,
        recipient_field,
    ];

    // Strict Groth16 verification — encoding fix landed 2026-04-25, see
    // settle_batch.rs for the long story.
    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &CLAIM_VK,
    )
    .map_err(|e| {
        msg!("Groth16Verifier::new rejected: {:?}", e);
        PredacyError::ProofVerificationFailed
    })?;
    verifier.verify().map_err(|e| {
        msg!("Claim proof verify failed: {:?}", e);
        PredacyError::ProofVerificationFailed
    })?;

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
