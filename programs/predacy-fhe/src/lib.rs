//! Predacy REFHE strict-mode batch-clearing program.
//!
//! Runs Predacy's full four-side batch-clearing math inside Encrypt's FHE
//! executor. Given encrypted order fields (side, limit_price, amount) for
//! each of N orders and the plaintext-in-strict-mode clearing price, the
//! program returns four encrypted filled-volume aggregates:
//! (yes_buy_vol, no_buy_vol, yes_sell_qty, no_sell_qty).
//!
//! This is the on-chain twin of `relayer/src/encryptedClearing.ts`. The
//! TS path is the mock that proves the algorithm runs bit-identical
//! against plaintext; this Rust path is the real Encrypt integration
//! that compiles our clearing circuit into an FHE graph executed by their
//! coprocessor (program `4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`)
//! on Solana devnet.
//!
//! Scoped to 4 orders per batch instead of the Groth16 path's 8 because
//! a 4-order graph's input/output ciphertext accounts (13 in + 4 out)
//! fit in a standard Solana tx without address lookup tables. Extending
//! to 8 is a loop unroll + versioned-tx migration — not new logic.
//!
//! Side encoding (matches clearingPrice.ts + batch_clearing.circom):
//!   0 = YES_BUY, 1 = YES_SELL, 2 = NO_BUY, 3 = NO_SELL

use anchor_lang::prelude::*;
use encrypt_anchor::EncryptContext;
use encrypt_dsl::prelude::encrypt_fn;
// EUint64 imported implicitly by the macro; same for the traits that make
// `is_equal`/`is_greater_or_equal`/`is_less_or_equal` available.

declare_id!("59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn");


// ── Bisect probes — isolate which dimension breaks executor processing ──


// ─── FHE graph ───────────────────────────────────────────────────────────
//
// Full four-side batch clearing over 4 orders, expressed as arithmetic-only
// homomorphic ops (no plaintext branches on ciphertext values — same
// structural trick the Groth16 Circom circuit uses). Roughly:
//
//   per order i ∈ {0..3}, per side s ∈ {YES_BUY, YES_SELL, NO_BUY, NO_SELL}:
//       is_side[i][s]   = (o{i}_side == s)
//       fills[i][s]     = per-side price comparison vs (clearing_price or
//                         1M - clearing_price)
//       masked_qty[i][s] = is_side[i][s] * fills[i][s] * o{i}_amount
//   filled[s] = Σ_i masked_qty[i][s]
//
// Op count: ~20 ops per order (4 eq + 4 ge/le + 12 mul + 4 add) + noprice.
// Total for 4 orders ≈ 80 ops + constants. Well under Encrypt's op budget.
//
// In plaintext-simulation on Encrypt's pre-alpha devnet the values are
// public — but the GRAPH is the production FHE circuit. When Encrypt ships
// Alpha 1 with real homomorphic execution, this exact bytecode runs
// confidentially with zero program change.

#[encrypt_fn]
fn settle_batch_graph(
    o0_side: EUint8, o0_limit: EUint64, o0_amount: EUint64,
    o1_side: EUint8, o1_limit: EUint64, o1_amount: EUint64,
    o2_side: EUint8, o2_limit: EUint64, o2_amount: EUint64,
    o3_side: EUint8, o3_limit: EUint64, o3_amount: EUint64,
    clearing_price: EUint64,
) -> (EUint64, EUint64, EUint64, EUint64) {
    // Use if/else for masking instead of EUint8 × EUint64 multiplication
    // (which truncates to 1 byte per the mock engine's lookup width).
    // Order 0
    let o0_is_yb = o0_side == 0u8;
    let o0_is_ys = o0_side == 1u8;
    let o0_is_nb = o0_side == 2u8;
    let o0_is_ns = o0_side == 3u8;
    let o0_plus_cp = o0_limit + clearing_price;
    let o0_yb_fill = o0_is_yb * (o0_limit >= clearing_price);
    let o0_ys_fill = o0_is_ys * (o0_limit <= clearing_price);
    let o0_nb_fill = o0_is_nb * (o0_plus_cp >= 1_000_000u64);
    let o0_ns_fill = o0_is_ns * (o0_plus_cp <= 1_000_000u64);
    let o0_zero = o0_amount * 0u64;
    let o0_yb = if o0_yb_fill { o0_amount } else { o0_zero };
    let o0_ys = if o0_ys_fill { o0_amount } else { o0_zero };
    let o0_nb = if o0_nb_fill { o0_amount } else { o0_zero };
    let o0_ns = if o0_ns_fill { o0_amount } else { o0_zero };

    // Order 1
    let o1_is_yb = o1_side == 0u8;
    let o1_is_ys = o1_side == 1u8;
    let o1_is_nb = o1_side == 2u8;
    let o1_is_ns = o1_side == 3u8;
    let o1_plus_cp = o1_limit + clearing_price;
    let o1_yb_fill = o1_is_yb * (o1_limit >= clearing_price);
    let o1_ys_fill = o1_is_ys * (o1_limit <= clearing_price);
    let o1_nb_fill = o1_is_nb * (o1_plus_cp >= 1_000_000u64);
    let o1_ns_fill = o1_is_ns * (o1_plus_cp <= 1_000_000u64);
    let o1_zero = o1_amount * 0u64;
    let o1_yb = if o1_yb_fill { o1_amount } else { o1_zero };
    let o1_ys = if o1_ys_fill { o1_amount } else { o1_zero };
    let o1_nb = if o1_nb_fill { o1_amount } else { o1_zero };
    let o1_ns = if o1_ns_fill { o1_amount } else { o1_zero };

    // Order 2
    let o2_is_yb = o2_side == 0u8;
    let o2_is_ys = o2_side == 1u8;
    let o2_is_nb = o2_side == 2u8;
    let o2_is_ns = o2_side == 3u8;
    let o2_plus_cp = o2_limit + clearing_price;
    let o2_yb_fill = o2_is_yb * (o2_limit >= clearing_price);
    let o2_ys_fill = o2_is_ys * (o2_limit <= clearing_price);
    let o2_nb_fill = o2_is_nb * (o2_plus_cp >= 1_000_000u64);
    let o2_ns_fill = o2_is_ns * (o2_plus_cp <= 1_000_000u64);
    let o2_zero = o2_amount * 0u64;
    let o2_yb = if o2_yb_fill { o2_amount } else { o2_zero };
    let o2_ys = if o2_ys_fill { o2_amount } else { o2_zero };
    let o2_nb = if o2_nb_fill { o2_amount } else { o2_zero };
    let o2_ns = if o2_ns_fill { o2_amount } else { o2_zero };

    // Order 3
    let o3_is_yb = o3_side == 0u8;
    let o3_is_ys = o3_side == 1u8;
    let o3_is_nb = o3_side == 2u8;
    let o3_is_ns = o3_side == 3u8;
    let o3_plus_cp = o3_limit + clearing_price;
    let o3_yb_fill = o3_is_yb * (o3_limit >= clearing_price);
    let o3_ys_fill = o3_is_ys * (o3_limit <= clearing_price);
    let o3_nb_fill = o3_is_nb * (o3_plus_cp >= 1_000_000u64);
    let o3_ns_fill = o3_is_ns * (o3_plus_cp <= 1_000_000u64);
    let o3_zero = o3_amount * 0u64;
    let o3_yb = if o3_yb_fill { o3_amount } else { o3_zero };
    let o3_ys = if o3_ys_fill { o3_amount } else { o3_zero };
    let o3_nb = if o3_nb_fill { o3_amount } else { o3_zero };
    let o3_ns = if o3_ns_fill { o3_amount } else { o3_zero };

    // Accumulate per-side totals across all 4 orders.
    let filled_yes_buy  = o0_yb + o1_yb + o2_yb + o3_yb;
    let filled_yes_sell = o0_ys + o1_ys + o2_ys + o3_ys;
    let filled_no_buy   = o0_nb + o1_nb + o2_nb + o3_nb;
    let filled_no_sell  = o0_ns + o1_ns + o2_ns + o3_ns;

    (filled_yes_buy, filled_no_buy, filled_yes_sell, filled_no_sell)
}

// ─── State ──────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct BatchSettlementRecord {
    pub authority: Pubkey,
    pub market_id: [u8; 32],
    pub batch_index: u64,
    // Ciphertext account pubkeys for the 4 encrypted output aggregates.
    pub yes_buy_vol_ct: [u8; 32],
    pub no_buy_vol_ct: [u8; 32],
    pub yes_sell_qty_ct: [u8; 32],
    pub no_sell_qty_ct: [u8; 32],
    // Decryption state (digest of a pending request, then revealed values).
    pub pending_decryption_digest: [u8; 32],
    pub revealed_yes_buy: u64,
    pub revealed_no_buy: u64,
    pub revealed_yes_sell: u64,
    pub revealed_no_sell: u64,
    pub bump: u8,
}

// ─── Instructions ──────────────────────────────────────────────────────

#[program]
pub mod predacy_fhe {
    use super::*;

    /// Open a record for a 4-order FHE batch settlement.
    pub fn register_batch(
        ctx: Context<RegisterBatch>,
        market_id: [u8; 32],
        batch_index: u64,
        yes_buy_vol_ct: [u8; 32],
        no_buy_vol_ct: [u8; 32],
        yes_sell_qty_ct: [u8; 32],
        no_sell_qty_ct: [u8; 32],
    ) -> Result<()> {
        let rec = &mut ctx.accounts.record;
        rec.authority = ctx.accounts.authority.key();
        rec.market_id = market_id;
        rec.batch_index = batch_index;
        rec.yes_buy_vol_ct = yes_buy_vol_ct;
        rec.no_buy_vol_ct = no_buy_vol_ct;
        rec.yes_sell_qty_ct = yes_sell_qty_ct;
        rec.no_sell_qty_ct = no_sell_qty_ct;
        rec.pending_decryption_digest = [0u8; 32];
        rec.revealed_yes_buy = 0;
        rec.revealed_no_buy = 0;
        rec.revealed_yes_sell = 0;
        rec.revealed_no_sell = 0;
        rec.bump = ctx.bumps.record;
        Ok(())
    }

    /// Run `settle_batch_graph` via Encrypt CPI.
    ///
    /// Accepts 13 input ciphertext accounts (4 orders × 3 fields + clearing
    /// price) and 4 output ciphertexts — the FHE graph executes on
    /// Encrypt's coprocessor and writes the aggregates to the output
    /// accounts.
    pub fn settle_fhe_batch(
        ctx: Context<SettleFheBatch>,
        cpi_authority_bump: u8,
    ) -> Result<()> {
        let encrypt_ctx = EncryptContext {
            encrypt_program: ctx.accounts.encrypt_program.to_account_info(),
            config: ctx.accounts.config.to_account_info(),
            deposit: ctx.accounts.deposit.to_account_info(),
            cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
            caller_program: ctx.accounts.caller_program.to_account_info(),
            network_encryption_key: ctx.accounts.network_encryption_key.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            event_authority: ctx.accounts.event_authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            cpi_authority_bump,
        };

        // Inputs first, then outputs — matches encrypt_fn arg ordering.
        encrypt_ctx.settle_batch_graph(
            // Order 0
            ctx.accounts.o0_side_ct.to_account_info(),
            ctx.accounts.o0_limit_ct.to_account_info(),
            ctx.accounts.o0_amount_ct.to_account_info(),
            // Order 1
            ctx.accounts.o1_side_ct.to_account_info(),
            ctx.accounts.o1_limit_ct.to_account_info(),
            ctx.accounts.o1_amount_ct.to_account_info(),
            // Order 2
            ctx.accounts.o2_side_ct.to_account_info(),
            ctx.accounts.o2_limit_ct.to_account_info(),
            ctx.accounts.o2_amount_ct.to_account_info(),
            // Order 3
            ctx.accounts.o3_side_ct.to_account_info(),
            ctx.accounts.o3_limit_ct.to_account_info(),
            ctx.accounts.o3_amount_ct.to_account_info(),
            // Clearing price
            ctx.accounts.clearing_price_ct.to_account_info(),
            // Outputs
            ctx.accounts.yes_buy_vol_ct.to_account_info(),
            ctx.accounts.no_buy_vol_ct.to_account_info(),
            ctx.accounts.yes_sell_qty_ct.to_account_info(),
            ctx.accounts.no_sell_qty_ct.to_account_info(),
        )?;
        Ok(())
    }

    /// Mark an output ciphertext as fully public so anyone can read it
    /// via Encrypt's gRPC `ReadCiphertext`. Calls Encrypt's `make_public`
    /// ix (opcode 10).
    pub fn make_output_public(
        ctx: Context<MakeOutputPublic>,
        cpi_authority_bump: u8,
    ) -> Result<()> {
        use anchor_lang::solana_program::{
            instruction::{AccountMeta, Instruction},
            program::invoke_signed,
        };

        const IX_MAKE_PUBLIC: u8 = 10;
        const CPI_AUTHORITY_SEED: &[u8] = b"__encrypt_cpi_authority";

        let ix = Instruction {
            program_id: ctx.accounts.encrypt_program.key(),
            data: vec![IX_MAKE_PUBLIC],
            accounts: vec![
                AccountMeta::new(ctx.accounts.ciphertext.key(), false),
                AccountMeta::new_readonly(ctx.accounts.caller_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.cpi_authority.key(), true),
            ],
        };

        let seeds: &[&[u8]] = &[CPI_AUTHORITY_SEED, &[cpi_authority_bump]];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.ciphertext.to_account_info(),
                ctx.accounts.caller_program.to_account_info(),
                ctx.accounts.cpi_authority.to_account_info(),
                ctx.accounts.encrypt_program.to_account_info(),
            ],
            &[seeds],
        )?;
        Ok(())
    }


    /// Pre-create an output ciphertext for the FHE graph to overwrite.
    ///
    /// Calls Encrypt's `create_plaintext_ciphertext` ix (opcode 2) directly.
    /// This is the on-chain path for output accounts — they're created
    /// authorized to our CPI authority so the graph executor can overwrite
    /// them during `settle_fhe_batch`.
    pub fn create_output_ct(
        ctx: Context<CreateOutputCt>,
        cpi_authority_bump: u8,
        fhe_type: u8,
    ) -> Result<()> {
        use anchor_lang::solana_program::{
            instruction::{AccountMeta, Instruction},
            program::invoke_signed,
        };

        const IX_CREATE_PLAINTEXT: u8 = 2;
        const CPI_AUTHORITY_SEED: &[u8] = b"__encrypt_cpi_authority";

        // ix_data: opcode(1) | fhe_type(1) | plaintext_le(byte_width)
        // For Uint64, byte_width=8, plaintext=0 → 10 bytes total.
        // For Uint8, byte_width=1, plaintext=0 → 3 bytes total.
        let plaintext_width = match fhe_type {
            1 => 1,  // Uint8
            4 => 8,  // Uint64
            _ => return Err(error!(PredacyFheError::DecryptionIncomplete)),
        };
        let mut ix_data = Vec::with_capacity(2 + plaintext_width);
        ix_data.push(IX_CREATE_PLAINTEXT);
        ix_data.push(fhe_type);
        ix_data.extend(std::iter::repeat(0u8).take(plaintext_width));

        let ix = Instruction {
            program_id: ctx.accounts.encrypt_program.key(),
            data: ix_data,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.config.key(), false),
                AccountMeta::new(ctx.accounts.deposit.key(), false),
                AccountMeta::new(ctx.accounts.ciphertext.key(), true),
                AccountMeta::new_readonly(ctx.accounts.caller_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.cpi_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.network_encryption_key.key(), false),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.encrypt_program.key(), false),
            ],
        };

        let seeds: &[&[u8]] = &[CPI_AUTHORITY_SEED, &[cpi_authority_bump]];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.config.to_account_info(),
                ctx.accounts.deposit.to_account_info(),
                ctx.accounts.ciphertext.to_account_info(),
                ctx.accounts.caller_program.to_account_info(),
                ctx.accounts.cpi_authority.to_account_info(),
                ctx.accounts.network_encryption_key.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.encrypt_program.to_account_info(),
            ],
            &[seeds],
        )?;

        Ok(())
    }

    /// Request off-chain decryption of an output ciphertext.
    ///
    /// Calls Encrypt's `request_decryption` ix (opcode 11) directly via CPI.
    /// We pass `request_acct` with `is_signer=true` because Encrypt's handler
    /// internally calls `system_instruction::create_account` which needs
    /// the new account to sign — the SDK's wrapper omits this signer flag,
    /// so we build the AccountMetas ourselves.
    /// Snapshots the ciphertext digest into the record for reveal-time verification.
    pub fn request_output_decryption(
        ctx: Context<RequestOutputDecryption>,
        cpi_authority_bump: u8,
    ) -> Result<()> {
        use anchor_lang::solana_program::{
            instruction::{AccountMeta, Instruction},
            program::invoke_signed,
        };

        // Snapshot digest from the ciphertext (bytes 2..34 of its 100-byte data).
        let ct_data = ctx.accounts.output_ct.try_borrow_data()?;
        require!(ct_data.len() >= 100, PredacyFheError::DecryptionIncomplete);
        let mut digest = [0u8; 32];
        digest.copy_from_slice(&ct_data[2..34]);
        drop(ct_data);

        const IX_REQUEST_DECRYPTION: u8 = 11;
        const CPI_AUTHORITY_SEED: &[u8] = b"__encrypt_cpi_authority";

        let ix = Instruction {
            program_id: ctx.accounts.encrypt_program.key(),
            data: vec![IX_REQUEST_DECRYPTION],
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.config.key(), false),
                AccountMeta::new(ctx.accounts.deposit.key(), false),
                AccountMeta::new(ctx.accounts.request_acct.key(), true),  // signer ✓
                AccountMeta::new_readonly(ctx.accounts.caller_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.cpi_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.output_ct.key(), false),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.encrypt_program.key(), false),
            ],
        };

        let seeds: &[&[u8]] = &[CPI_AUTHORITY_SEED, &[cpi_authority_bump]];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.config.to_account_info(),
                ctx.accounts.deposit.to_account_info(),
                ctx.accounts.request_acct.to_account_info(),
                ctx.accounts.caller_program.to_account_info(),
                ctx.accounts.cpi_authority.to_account_info(),
                ctx.accounts.output_ct.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.encrypt_program.to_account_info(),
            ],
            &[seeds],
        )?;

        ctx.accounts.record.pending_decryption_digest = digest;
        Ok(())
    }
}

// ─── Accounts ───────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(market_id: [u8; 32], batch_index: u64)]
pub struct RegisterBatch<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + BatchSettlementRecord::INIT_SPACE,
        seeds = [
            b"fhe_batch",
            market_id.as_ref(),
            &batch_index.to_le_bytes(),
        ],
        bump,
    )]
    pub record: Account<'info, BatchSettlementRecord>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleFheBatch<'info> {
    #[account(mut)]
    pub record: Account<'info, BatchSettlementRecord>,

    // Order 0 input ciphertexts.
    /// CHECK: Encrypt ciphertext — encrypted order side.
    #[account(mut)] pub o0_side_ct: UncheckedAccount<'info>,
    /// CHECK: Encrypt ciphertext — encrypted limit price.
    #[account(mut)] pub o0_limit_ct: UncheckedAccount<'info>,
    /// CHECK: Encrypt ciphertext — encrypted amount.
    #[account(mut)] pub o0_amount_ct: UncheckedAccount<'info>,

    // Order 1.
    /// CHECK: see order 0.
    #[account(mut)] pub o1_side_ct: UncheckedAccount<'info>,
    /// CHECK: see order 0.
    #[account(mut)] pub o1_limit_ct: UncheckedAccount<'info>,
    /// CHECK: see order 0.
    #[account(mut)] pub o1_amount_ct: UncheckedAccount<'info>,

    // Order 2.
    /// CHECK: see order 0.
    #[account(mut)] pub o2_side_ct: UncheckedAccount<'info>,
    /// CHECK: see order 0.
    #[account(mut)] pub o2_limit_ct: UncheckedAccount<'info>,
    /// CHECK: see order 0.
    #[account(mut)] pub o2_amount_ct: UncheckedAccount<'info>,

    // Order 3.
    /// CHECK: see order 0.
    #[account(mut)] pub o3_side_ct: UncheckedAccount<'info>,
    /// CHECK: see order 0.
    #[account(mut)] pub o3_limit_ct: UncheckedAccount<'info>,
    /// CHECK: see order 0.
    #[account(mut)] pub o3_amount_ct: UncheckedAccount<'info>,

    /// CHECK: Encrypt ciphertext — clearing price public input.
    #[account(mut)] pub clearing_price_ct: UncheckedAccount<'info>,

    // Output ciphertexts (4 filled-volume aggregates).
    /// CHECK: yes_buy filled-volume output.
    #[account(mut)] pub yes_buy_vol_ct: UncheckedAccount<'info>,
    /// CHECK: no_buy filled-volume output.
    #[account(mut)] pub no_buy_vol_ct: UncheckedAccount<'info>,
    /// CHECK: yes_sell filled-quantity output.
    #[account(mut)] pub yes_sell_qty_ct: UncheckedAccount<'info>,
    /// CHECK: no_sell filled-quantity output.
    #[account(mut)] pub no_sell_qty_ct: UncheckedAccount<'info>,

    // ── Encrypt infrastructure ──
    /// CHECK: Encrypt coprocessor program.
    pub encrypt_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt config PDA. Marked mut because Encrypt's
    /// `execute_graph` ix requests writable access to it (op-budget update).
    #[account(mut)] pub config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit (op-budget rent).
    #[account(mut)] pub deposit: UncheckedAccount<'info>,
    /// CHECK: Our program's CPI-authority PDA.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: Caller program (predacy-fhe).
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Network encryption key.
    pub network_encryption_key: UncheckedAccount<'info>,
    /// CHECK: Event authority.
    pub event_authority: UncheckedAccount<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// Macro generating Encrypt CPI infrastructure fields. Used by all bisect probe structs.
macro_rules! encrypt_cpi_fields {
    () => {
        /// CHECK: encrypt program
        pub encrypt_program: UncheckedAccount<'info>,
        /// CHECK: encrypt config
        #[account(mut)] pub config: UncheckedAccount<'info>,
        /// CHECK: encrypt deposit
        #[account(mut)] pub deposit: UncheckedAccount<'info>,
        /// CHECK: cpi authority
        pub cpi_authority: UncheckedAccount<'info>,
        /// CHECK: caller program
        pub caller_program: UncheckedAccount<'info>,
        /// CHECK: network encryption key
        pub network_encryption_key: UncheckedAccount<'info>,
        /// CHECK: event authority
        pub event_authority: UncheckedAccount<'info>,
        #[account(mut)] pub payer: Signer<'info>,
        pub system_program: Program<'info, System>,
    };
}


#[derive(Accounts)]
pub struct MakeOutputPublic<'info> {
    /// CHECK: Encrypt ciphertext to mark public.
    #[account(mut)] pub ciphertext: UncheckedAccount<'info>,
    /// CHECK: predacy-fhe CPI authority.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: Caller program (predacy-fhe).
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: Encrypt coprocessor program.
    pub encrypt_program: UncheckedAccount<'info>,
}


#[derive(Accounts)]
pub struct CreateOutputCt<'info> {
    /// CHECK: Fresh keypair the caller signs for. Encrypt creates the account.
    #[account(mut, signer)]
    pub ciphertext: UncheckedAccount<'info>,
    /// CHECK: Encrypt config PDA.
    pub config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit (op-budget update).
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: predacy-fhe CPI authority PDA.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: caller_program (predacy-fhe).
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: network encryption key PDA.
    pub network_encryption_key: UncheckedAccount<'info>,
    /// CHECK: Encrypt event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Encrypt coprocessor program.
    pub encrypt_program: UncheckedAccount<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestOutputDecryption<'info> {
    #[account(mut)]
    pub record: Account<'info, BatchSettlementRecord>,
    /// CHECK: Output ciphertext to decrypt (one of yes_buy_vol / etc).
    pub output_ct: UncheckedAccount<'info>,
    /// CHECK: Fresh keypair for the DecryptionRequest account, created by Encrypt.
    #[account(mut, signer)]
    pub request_acct: UncheckedAccount<'info>,
    /// CHECK: Encrypt config PDA — Encrypt's request_decryption requires it readable.
    pub config: UncheckedAccount<'info>,
    /// CHECK: Encrypt deposit (op-budget update).
    #[account(mut)]
    pub deposit: UncheckedAccount<'info>,
    /// CHECK: predacy-fhe CPI authority PDA.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: caller_program (predacy-fhe).
    pub caller_program: UncheckedAccount<'info>,
    /// CHECK: network encryption key PDA.
    pub network_encryption_key: UncheckedAccount<'info>,
    /// CHECK: Encrypt event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: Encrypt coprocessor program.
    pub encrypt_program: UncheckedAccount<'info>,
    #[account(mut)] pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum PredacyFheError {
    #[msg("Unauthorized — only the record authority can call this")]
    Unauthorized,
    #[msg("Decryption has not been attested yet by Encrypt's aggregator network")]
    DecryptionIncomplete,
}
