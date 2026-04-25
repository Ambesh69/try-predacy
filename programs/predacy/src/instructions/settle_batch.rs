use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use groth16_solana::groth16::Groth16Verifier;

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::BatchSettled;
use crate::state::{Batch, BatchStatus, Market};
use crate::vkeys::BATCH_VK;

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

/// Encode a u64 as a 32-byte big-endian array (BN254 field element).
#[inline(always)]
fn u64_to_be32(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

pub fn handler(
    ctx: Context<SettleBatch>,
    claim_merkle_root: [u8; 32],
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    // Order count claimed by the prover. The circuit uses this as a public
    // input; on-chain we accept it as an arg rather than reading from batch
    // state because the relayer currently computes everything off-chain
    // (commit_order is not submitted per order — a production hardening
    // step tracked separately). If the relayer lies about order_count,
    // the proof's `commitments[]` witness won't match the claimed
    // commitment_root (the circuit hashes all 8 padded slots), so verify
    // still fails.
    order_count: u16,
) -> Result<()> {
    let batch = &mut ctx.accounts.batch;

    // Verify batch is LOCKED
    require!(batch.status() == BatchStatus::Locked, PredacyError::InvalidBatchStatus);

    // ─── Groth16 verification of the batch clearing proof ───
    // Circuit's 7 public inputs, in order (see circuits/batch_clearing/batch_clearing.circom):
    //   1. commitmentRoot     — Poseidon chain of per-order commitments
    //   2. clearingPrice      — 6-decimal fixed point
    //   3. filledYesBuyVol    — USDC
    //   4. filledNoBuyVol     — USDC
    //   5. filledYesSellQty   — YES tokens
    //   6. filledNoSellQty    — NO tokens
    //   7. orderCount         — number of non-padding orders
    //
    // The circuit verifies: each commitment matches its preimage, the Poseidon
    // root matches commitmentRoot, and the clearing algorithm produces the
    // claimed filled volumes. If the relayer lied about ANY of these, the
    // proof won't verify and the batch can't settle.
    let public_inputs: [[u8; 32]; 7] = [
        batch.commitment_root,
        u64_to_be32(batch.clearing_price),
        u64_to_be32(batch.filled_yes_buy_vol),
        u64_to_be32(batch.filled_no_buy_vol),
        u64_to_be32(batch.filled_yes_sell_qty),
        u64_to_be32(batch.filled_no_sell_qty),
        u64_to_be32(order_count as u64),
    ];

    // Strict Groth16 verification. Earlier diagnosis showed our G2 proof
    // encoding was over-swapped — parse_vk_to_rust.js already writes the
    // vkey in EIP-197 c1/c0 order, and the SBF `alt_bn128_pairing` syscall
    // applies the same ordering internally, so proofs must be in the
    // natural snarkjs (c0/c1) order. Fixed in zkProver.ts / zkClaimProver.ts
    // on 2026-04-25. Validated by successfully verifying groth16-solana's
    // own canonical test vectors on devnet (see verify_test_vectors ix).
    let mut verifier = Groth16Verifier::new(
        &proof_a,
        &proof_b,
        &proof_c,
        &public_inputs,
        &BATCH_VK,
    )
    .map_err(|e| {
        msg!("Groth16Verifier::new rejected: {:?}", e);
        PredacyError::ProofVerificationFailed
    })?;
    verifier.verify().map_err(|e| {
        msg!("Groth16 pairing verify failed: {:?}", e);
        PredacyError::ProofVerificationFailed
    })?;

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
