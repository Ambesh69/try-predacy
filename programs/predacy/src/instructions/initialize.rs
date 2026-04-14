use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::ProtocolConfig;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [PROTOCOL_SEED],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub authority: Signer<'info>,

    /// The USDC mint on Solana
    pub usdc_mint: Account<'info, anchor_spl::token::Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeProtocol>) -> Result<()> {
    let config = &mut ctx.accounts.protocol_config;
    config.authority = ctx.accounts.authority.key();
    config.treasury = ctx.accounts.authority.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.batch_window_secs = DEFAULT_BATCH_WINDOW;
    config.max_orders_per_batch = DEFAULT_MAX_ORDERS;
    config.bump = ctx.bumps.protocol_config;
    Ok(())
}
