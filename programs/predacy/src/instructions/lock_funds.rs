use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::FundsLocked;
use crate::state::{Batch, BatchStatus, CommitmentStore, Market};

/// Check commitment_root arg matches the CommitmentStore's count.
/// We can't recompute Poseidon on-chain (too expensive), so we trust the
/// relayer here — the Groth16 proof in settle_batch enforces that this root
/// was derived from the actual committed hashes. The proof circuit rebuilds
/// the Poseidon hash chain from the order preimages and checks it matches.

#[derive(Accounts)]
pub struct LockFunds<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [BATCH_SEED, &batch.market_id, &batch.batch_index.to_le_bytes()],
        bump = batch.bump,
        constraint = batch.market_id == market.market_id @ PredacyError::BatchMarketMismatch,
    )]
    pub batch: Box<Account<'info, Batch>>,

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

    #[account(mut, address = market.yes_mint)]
    pub yes_mint: Box<Account<'info, Mint>>,
    #[account(mut, address = market.no_mint)]
    pub no_mint: Box<Account<'info, Mint>>,

    /// Relayer's USDC account (receives gap USDC)
    #[account(mut)]
    pub relayer_usdc: Box<Account<'info, TokenAccount>>,
    /// Relayer's YES token account (receives excess YES tokens)
    #[account(mut)]
    pub relayer_yes: Box<Account<'info, TokenAccount>>,
    /// Relayer's NO token account (receives excess NO tokens)
    #[account(mut)]
    pub relayer_no: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub relayer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<LockFunds>,
    clearing_price: u64,
    filled_yes_buy_vol: u64,
    filled_no_buy_vol: u64,
    filled_yes_sell_qty: u64,
    filled_no_sell_qty: u64,
    yes_gap: u64,
    no_gap: u64,
    final_excess_yes: u64,
    final_excess_no: u64,
    // Relayer-provided Poseidon commitment_root (matches ZK circuit).
    // Enforced by the Groth16 proof in settle_batch.
    commitment_root: [u8; 32],
) -> Result<()> {
    let batch = &mut ctx.accounts.batch;
    let market = &ctx.accounts.market;

    // Verify batch is in SETTLING status
    require!(batch.status() == BatchStatus::Settling, PredacyError::InvalidBatchStatus);

    // Verify clearing price validity (0 < price < 1_000_000)
    require!(clearing_price > 0 && clearing_price < PRICE_DECIMALS, PredacyError::InvalidClearingPrice);

    // Touch the commitment_store so Anchor verifies the seeds/bump match this
    // batch. The actual root is Poseidon-based (computed off-chain) and
    // enforced by the Groth16 proof in settle_batch — on-chain we just make
    // sure the account exists with the right count.
    let store = ctx.accounts.commitment_store.load()?;
    require!(
        store.count as u16 == batch.commitment_count,
        PredacyError::CommitmentMismatch
    );

    // Store settlement results
    batch.clearing_price = clearing_price;
    batch.commitment_root = commitment_root;
    batch.filled_yes_buy_vol = filled_yes_buy_vol;
    batch.filled_no_buy_vol = filled_no_buy_vol;
    batch.filled_yes_sell_qty = filled_yes_sell_qty;
    batch.filled_no_sell_qty = filled_no_sell_qty;
    batch.yes_gap = yes_gap;
    batch.no_gap = no_gap;
    batch.final_excess_yes = final_excess_yes;
    batch.final_excess_no = final_excess_no;

    // PDA signer seeds for market
    let market_id = market.market_id;
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &market_id, &bump]];

    // Mint YES tokens for filled YES buy orders
    if filled_yes_buy_vol > 0 {
        let yes_tokens = filled_yes_buy_vol
            .checked_mul(PRICE_DECIMALS)
            .ok_or(PredacyError::Overflow)?
            .checked_div(clearing_price)
            .ok_or(PredacyError::Overflow)?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    to: ctx.accounts.yes_vault.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            yes_tokens,
        )?;
    }

    // Mint NO tokens for filled NO buy orders
    if filled_no_buy_vol > 0 {
        let no_price = PRICE_DECIMALS.checked_sub(clearing_price).ok_or(PredacyError::Overflow)?;
        let no_tokens = filled_no_buy_vol
            .checked_mul(PRICE_DECIMALS)
            .ok_or(PredacyError::Overflow)?
            .checked_div(no_price)
            .ok_or(PredacyError::Overflow)?;
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    to: ctx.accounts.no_vault.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            no_tokens,
        )?;
    }

    // Send gap USDC to relayer (so relayer can buy gap tokens on CLOB)
    if yes_gap > 0 || no_gap > 0 {
        let gap_usdc = yes_gap
            .checked_mul(clearing_price).ok_or(PredacyError::Overflow)?
            .checked_div(PRICE_DECIMALS).ok_or(PredacyError::Overflow)?
            .checked_add(
                no_gap
                    .checked_mul(PRICE_DECIMALS.checked_sub(clearing_price).ok_or(PredacyError::Overflow)?)
                    .ok_or(PredacyError::Overflow)?
                    .checked_div(PRICE_DECIMALS)
                    .ok_or(PredacyError::Overflow)?
            ).ok_or(PredacyError::Overflow)?;

        if gap_usdc > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.usdc_vault.to_account_info(),
                        to: ctx.accounts.relayer_usdc.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                gap_usdc,
            )?;
        }
    }

    // Send excess YES tokens to relayer (relayer sells on CLOB)
    if final_excess_yes > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.yes_vault.to_account_info(),
                    to: ctx.accounts.relayer_yes.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            final_excess_yes,
        )?;
    }

    // Send excess NO tokens to relayer
    if final_excess_no > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.no_vault.to_account_info(),
                    to: ctx.accounts.relayer_no.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            final_excess_no,
        )?;
    }

    batch.status = BatchStatus::Locked as u8;

    emit!(FundsLocked {
        batch_index: batch.batch_index,
        clearing_price,
        filled_yes_buy_vol,
        filled_no_buy_vol,
        filled_yes_sell_qty,
        filled_no_sell_qty,
        yes_gap,
        no_gap,
    });

    Ok(())
}
