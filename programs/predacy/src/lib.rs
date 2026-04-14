pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("Bb3zRkLip445BQ1S44PC115aws8CCyag4KFkch9ZcKjp");

#[program]
pub mod predacy {
    use super::*;

    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    pub fn create_market(ctx: Context<CreateMarket>, market_id: [u8; 32]) -> Result<()> {
        instructions::create_market::handler(ctx, market_id)
    }

    pub fn open_batch(ctx: Context<OpenBatch>) -> Result<()> {
        instructions::open_batch::handler(ctx)
    }

    pub fn commit_order(
        ctx: Context<CommitOrder>,
        commitment_hash: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::commit_order::handler(ctx, commitment_hash, amount)
    }

    pub fn commit_sell_order(
        ctx: Context<CommitSellOrder>,
        commitment_hash: [u8; 32],
        amount: u64,
        side: u8,
    ) -> Result<()> {
        instructions::commit_sell_order::handler(ctx, commitment_hash, amount, side)
    }

    pub fn close_batch(ctx: Context<CloseBatch>) -> Result<()> {
        instructions::close_batch::handler(ctx)
    }

    pub fn lock_funds(
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
    ) -> Result<()> {
        instructions::lock_funds::handler(
            ctx,
            clearing_price,
            filled_yes_buy_vol,
            filled_no_buy_vol,
            filled_yes_sell_qty,
            filled_no_sell_qty,
            yes_gap,
            no_gap,
            final_excess_yes,
            final_excess_no,
        )
    }

    pub fn settle_batch(
        ctx: Context<SettleBatch>,
        claim_merkle_root: [u8; 32],
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
    ) -> Result<()> {
        instructions::settle_batch::handler(ctx, claim_merkle_root, proof_a, proof_b, proof_c)
    }

    pub fn claim_with_proof(
        ctx: Context<ClaimWithProof>,
        nullifier_hash: [u8; 32],
        side: u8,
        filled_amount: u64,
        refund_amount: u64,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
    ) -> Result<()> {
        instructions::claim_with_proof::handler(
            ctx,
            nullifier_hash,
            side,
            filled_amount,
            refund_amount,
            proof_a,
            proof_b,
            proof_c,
        )
    }

    pub fn claim_position(
        ctx: Context<ClaimPosition>,
        commitment_index: u16,
        side: u8,
        amount: u64,
        limit_price: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        instructions::claim_position::handler(ctx, commitment_index, side, amount, limit_price, salt)
    }

    pub fn rescue_stuck_order(
        ctx: Context<RescueStuckOrder>,
        commitment_index: u16,
        side: u8,
        amount: u64,
        limit_price: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        instructions::rescue_stuck_order::handler(ctx, commitment_index, side, amount, limit_price, salt)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: u8) -> Result<()> {
        instructions::resolve_market::handler(ctx, outcome)
    }

    pub fn redeem_outcome(ctx: Context<RedeemOutcome>, amount: u64) -> Result<()> {
        instructions::redeem_outcome::handler(ctx, amount)
    }
}
