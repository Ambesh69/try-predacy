// init_bootstrap_pool: stand up a Tier 0 LS-LMSR pool for a specific
// market. Operator (EventHandle authority) calls this once after
// create_market and before the first batch needs cold-start liquidity.
//
// The seed_usdc value is taken from the EventHandle's `bootstrap_seed_usdc`
// field — a market doesn't get to override its parent event's seed. The
// caller's USDC ATA must hold at least `seed_usdc`; this ix moves that
// USDC into the market's PDA-owned `usdc_vault` so the LMSR's worst-
// case payout (b · ln 2 ≈ seed) is *actually* collateralized on-chain.
//
// Why funding-on-init now (vs. the prior pure-bookkeeping design):
// the old version left the seed as a u64 field on the BootstrapPool
// state with no matching on-chain USDC. When the LMSR filled a single-
// sided residual (e.g., one YES buyer, no NO buyers, clearing price
// 0.5), the program minted YES tokens against `filled_yes_buy_vol /
// price` shares while the vault only held the buyer's plaintext
// payment. At YES resolution the redeem path tried to pay out the full
// share-count and `0x1 InsufficientFunds` from the SPL token program
// because the LMSR's "$100 seed" was virtual. Funding-on-init makes
// the architectural promise ("LMSR has bounded loss = seed") true on-
// chain — every market that opens accepts orders only after its vault
// is real-money-backed.
//
// See docs/LIQUIDITY.md §5.1 for full design rationale.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::constants::*;
use crate::error::PredacyError;
use crate::state::{BootstrapPool, EventHandle, Market};

#[derive(Accounts)]
pub struct InitBootstrapPool<'info> {
    #[account(
        seeds = [MARKET_SEED, &market.market_id],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        seeds = [EVENT_HANDLE_SEED, &event_handle.handle_id],
        bump = event_handle.bump,
        // Only the EventHandle authority (relayer / operator) can stand up
        // pools under their event. This keeps random users from seeding
        // bogus pools.
        constraint = event_handle.authority == authority.key() @ PredacyError::Unauthorized,
        constraint = !event_handle.closed @ PredacyError::EventClosed,
    )]
    pub event_handle: Account<'info, EventHandle>,

    #[account(
        init,
        payer = authority,
        space = 8 + BootstrapPool::INIT_SPACE,
        seeds = [BOOTSTRAP_POOL_SEED, &market.market_id],
        bump,
    )]
    pub bootstrap_pool: Account<'info, BootstrapPool>,

    /// Market's USDC vault — receives the seed transfer. Must equal the
    /// `usdc_vault` field stamped on the Market account at create time.
    #[account(
        mut,
        address = market.usdc_vault @ PredacyError::Unauthorized,
        constraint = usdc_vault.mint == usdc_mint.key() @ PredacyError::Unauthorized,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// USDC mint — the protocol's collateral token.
    pub usdc_mint: Account<'info, Mint>,

    /// Authority's USDC ATA — source of the seed transfer. Must hold
    /// at least `event_handle.bootstrap_seed_usdc`. The authority signs
    /// the transfer below; no PDA seeds needed since `funder_usdc.owner
    /// == authority`.
    #[account(
        mut,
        constraint = funder_usdc.mint == usdc_mint.key() @ PredacyError::Unauthorized,
        constraint = funder_usdc.owner == authority.key() @ PredacyError::Unauthorized,
    )]
    pub funder_usdc: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitBootstrapPool>) -> Result<()> {
    let event = &ctx.accounts.event_handle;
    let market = &ctx.accounts.market;

    let seed = event.bootstrap_seed_usdc;
    require!(seed > 0, PredacyError::InsufficientBalance);
    require!(
        ctx.accounts.funder_usdc.amount >= seed,
        PredacyError::InsufficientBalance,
    );

    // b = (α / 10_000) × Q. With α = LMSR_ALPHA_BPS = 14_400 and Q = seed,
    // b ≈ 1.44 × seed. Worst-case loss for a binary market is b × ln(2) ≈ Q,
    // so a $100 seed bounds protocol loss at ~$100 per market — the cost of
    // running price discovery for this market until Tier 1 graduates in.
    let b_param = seed
        .checked_mul(LMSR_ALPHA_BPS)
        .ok_or(PredacyError::Overflow)?
        .checked_div(10_000)
        .ok_or(PredacyError::Overflow)?;

    let pool = &mut ctx.accounts.bootstrap_pool;
    pool.market_id = market.market_id;
    pool.event_handle = event.key();
    pool.seed_usdc = seed;
    pool.current_q = seed;
    pool.b_param = b_param;
    pool.yes_shares = 0;
    pool.no_shares = 0;
    pool.graduated = false;
    pool.realized_pnl = 0;
    pool.bump = ctx.bumps.bootstrap_pool;

    // Move seed into the market's USDC vault. This is the architectural
    // change that makes the LMSR's promised payout real — see the module
    // header comment for context. Authority signs as `funder_usdc.owner`,
    // so no PDA seeds are required for the transfer.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.funder_usdc.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        seed,
    )?;

    msg!(
        "[BootstrapPool] init market_id_prefix={:02x}{:02x}{:02x}{:02x} seed_usdc={} b_param={} (vault funded)",
        market.market_id[0],
        market.market_id[1],
        market.market_id[2],
        market.market_id[3],
        seed,
        b_param,
    );

    Ok(())
}
