use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::OutcomeRedeemed;
use crate::state::Market;

#[derive(Accounts)]
pub struct RedeemOutcome<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
        constraint = market.resolved @ PredacyError::MarketNotResolved,
    )]
    pub market: Account<'info, Market>,

    /// The winning outcome token mint (YES or NO)
    #[account(mut)]
    pub winning_mint: Account<'info, Mint>,

    /// User's winning token account (tokens to burn)
    #[account(
        mut,
        constraint = user_token_account.mint == winning_mint.key(),
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// User's USDC account (receives payout)
    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,

    /// Market's USDC vault (source of payout)
    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Account<'info, TokenAccount>,

    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RedeemOutcome>, amount: u64) -> Result<()> {
    let market = &ctx.accounts.market;

    // Verify the correct winning mint
    let is_yes_win = market.outcome == 1;
    let expected_mint = if is_yes_win { market.yes_mint } else { market.no_mint };
    require!(
        ctx.accounts.winning_mint.key() == expected_mint,
        PredacyError::InvalidOutcome,
    );

    // Burn winning tokens (1:1 redemption for USDC)
    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.winning_mint.to_account_info(),
                from: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // Transfer USDC from vault to user (1:1 — each winning token = 1 USDC unit)
    let market_id = market.market_id;
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] = &[&[MARKET_SEED, &market_id, &bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.usdc_vault.to_account_info(),
                to: ctx.accounts.user_usdc_account.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(OutcomeRedeemed {
        market_id: market.market_id,
        amount,
        recipient: ctx.accounts.user.key(),
    });

    Ok(())
}
