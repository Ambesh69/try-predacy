use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::state::{Market, ProtocolConfig};

#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct CreateMarket<'info> {
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &market_id],
        bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = market,
        seeds = [YES_MINT_SEED, &market_id],
        bump,
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = market,
        seeds = [NO_MINT_SEED, &market_id],
        bump,
    )]
    pub no_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [USDC_VAULT_SEED, &market_id],
        bump,
    )]
    pub usdc_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        token::mint = yes_mint,
        token::authority = market,
        seeds = [YES_VAULT_SEED, &market_id],
        bump,
    )]
    pub yes_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        token::mint = no_mint,
        token::authority = market,
        seeds = [NO_VAULT_SEED, &market_id],
        bump,
    )]
    pub no_vault: Box<Account<'info, TokenAccount>>,

    #[account(address = protocol_config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateMarket>, market_id: [u8; 32]) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.market_id = market_id;
    market.authority = ctx.accounts.authority.key();
    market.yes_mint = ctx.accounts.yes_mint.key();
    market.no_mint = ctx.accounts.no_mint.key();
    market.usdc_vault = ctx.accounts.usdc_vault.key();
    market.yes_vault = ctx.accounts.yes_vault.key();
    market.no_vault = ctx.accounts.no_vault.key();
    market.current_batch_index = 0;
    market.resolved = false;
    market.outcome = 0;
    market.bump = ctx.bumps.market;
    Ok(())
}
