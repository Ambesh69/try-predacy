pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod vkeys;

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

    /// Create an EventHandle PDA — the unit of LP commitment that downstream
    /// markets inherit fee and graduation parameters from. See
    /// docs/LIQUIDITY.md §4 for the full design rationale.
    #[allow(clippy::too_many_arguments)]
    pub fn create_event_handle(
        ctx: Context<CreateEventHandle>,
        handle_id: [u8; 32],
        category: u8,
        closes_at: i64,
        graduation_threshold_usdc: u64,
        graduation_batches: u8,
        fee_bps_taker: u16,
        fee_bps_treasury: u16,
        fee_bps_rebates: u16,
        bootstrap_seed_usdc: u64,
    ) -> Result<()> {
        instructions::create_event_handle::handler(
            ctx,
            handle_id,
            category,
            closes_at,
            graduation_threshold_usdc,
            graduation_batches,
            fee_bps_taker,
            fee_bps_treasury,
            fee_bps_rebates,
            bootstrap_seed_usdc,
        )
    }

    /// Initialise a Tier 0 LMSR Bootstrap Pool for a specific market.
    /// Caller must be the EventHandle authority. See docs/LIQUIDITY.md §5.1.
    pub fn init_bootstrap_pool(ctx: Context<InitBootstrapPool>) -> Result<()> {
        instructions::init_bootstrap_pool::handler(ctx)
    }

    /// Relayer-attested fill against the Tier 0 LMSR curve. Mutates curve
    /// state; actual token settlement still flows through lock_funds.
    /// Caller must be the EventHandle authority.
    pub fn bootstrap_fill(
        ctx: Context<BootstrapFill>,
        side: u8,
        qty_shares: u64,
        usdc_paid: u64,
        is_buy: bool,
    ) -> Result<()> {
        instructions::bootstrap_fill::handler(ctx, side, qty_shares, usdc_paid, is_buy)
    }

    /// Toggle a BootstrapPool's graduated flag. Used by the relayer once
    /// Tier 1 capital crosses the EventHandle's graduation_threshold; can
    /// be reverted if Tier 1 unexpectedly empties out.
    pub fn set_bootstrap_graduated(ctx: Context<BootstrapFill>, graduated: bool) -> Result<()> {
        instructions::bootstrap_fill::set_graduated_handler(ctx, graduated)
    }

    // ─── Liquidity Stack — Tier 1 (Blind LP, plaintext v1) ───
    // See docs/LIQUIDITY.md §5.2.

    /// LP deposits USDC under an EventHandle, receiving virtual shares
    /// against the per-event LP vault. Capital auto-refunds at
    /// `commitment_expires_at` via withdraw_lp_capital.
    pub fn commit_lp_capital(
        ctx: Context<CommitLpCapital>,
        amount: u64,
        commitment_expires_at: i64,
    ) -> Result<()> {
        instructions::commit_lp_capital::handler(ctx, amount, commitment_expires_at)
    }

    /// Relayer-attested per-batch state mutation. Records the LP vault's
    /// signed inventory delta and accrued rebate share.
    pub fn lp_settle_batch(
        ctx: Context<LpSettleBatch>,
        delta_yes_position: i64,
        delta_no_position: i64,
        rebate_share_usdc: u64,
    ) -> Result<()> {
        instructions::lp_settle_batch::handler(
            ctx,
            delta_yes_position,
            delta_no_position,
            rebate_share_usdc,
        )
    }

    /// LP (or auto-refund crank) redeems a position after the commitment
    /// window expires. Pro-rata payout from the vault's current USDC
    /// balance.
    pub fn withdraw_lp_capital(ctx: Context<WithdrawLpCapital>) -> Result<()> {
        instructions::withdraw_lp_capital::handler(ctx)
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
        // Relayer-computed Poseidon commitment_root (matches ZK circuit's root).
        // On-chain we can't cheaply compute Poseidon, so we accept it and let
        // the Groth16 proof in settle_batch enforce it matches the on-chain
        // commitment store. If the relayer lies about this root, the proof
        // won't verify.
        commitment_root: [u8; 32],
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
            commitment_root,
        )
    }

    pub fn settle_batch(
        ctx: Context<SettleBatch>,
        claim_merkle_root: [u8; 32],
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        order_count: u16,
    ) -> Result<()> {
        instructions::settle_batch::handler(
            ctx,
            claim_merkle_root,
            proof_a,
            proof_b,
            proof_c,
            order_count,
        )
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
        // Field-element-encoded recipient (BN254 scalar, BE, 32 bytes).
        // The circuit uses this as a public input binding the proof to a
        // specific recipient. The relayer must derive this by taking the
        // recipient owner pubkey bytes and masking the top 3 bits to 0 so
        // the value is guaranteed < BN254 field size.
        recipient_field: [u8; 32],
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
            recipient_field,
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

    /// Approve a message for Ika dWallet signing via CPI.
    /// Creates a MessageApproval PDA; Ika's network then writes a signature
    /// back into it. Used for cross-chain signing (Polygon/Polymarket).
    /// See `approve_ika_message.rs` for full usage.
    pub fn approve_ika_message(
        ctx: Context<ApproveIkaMessage>,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        message_approval_bump: u8,
    ) -> Result<()> {
        instructions::approve_ika_message::handler(
            ctx,
            message_digest,
            message_metadata_digest,
            user_pubkey,
            signature_scheme,
            message_approval_bump,
        )
    }

    /// Discriminator test: run `Groth16Verifier` with the canonical test
    /// vectors from groth16-solana's own test suite (mode=0), or with
    /// user-supplied proof bytes against our BATCH_VK (mode=1).
    pub fn verify_test_vectors(
        ctx: Context<VerifyTestVectors>,
        mode: u8,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        pub_inputs: [[u8; 32]; 7],
    ) -> Result<()> {
        instructions::verify_test_vectors::handler(ctx, mode, proof_a, proof_b, proof_c, pub_inputs)
    }
}
