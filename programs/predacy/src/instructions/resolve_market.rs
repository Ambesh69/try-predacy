use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::PredacyError;
use crate::events::MarketResolved;
use crate::state::Market;

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        constraint = authority.key() == market.authority @ PredacyError::Unauthorized,
    )]
    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<ResolveMarket>, outcome: u8) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(!market.resolved, PredacyError::MarketAlreadyResolved);
    require!(outcome == 1 || outcome == 2, PredacyError::InvalidOutcome);

    market.resolved = true;
    market.outcome = outcome;

    emit!(MarketResolved {
        market_id: market.market_id,
        outcome,
    });

    Ok(())
}
