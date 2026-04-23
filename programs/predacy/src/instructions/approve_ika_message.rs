use anchor_lang::prelude::*;
use ika_dwallet_anchor::{DWalletContext, CPI_AUTHORITY_SEED};

/// Approve a message for signing by a user's Ika dWallet.
///
/// This CPI-calls `approve_message` on the Ika dWallet program, which creates
/// a `MessageApproval` PDA on-chain. Once the PDA exists, Ika's validator
/// network (mock signer in Pre-Alpha) produces a signature and writes it back
/// into the PDA.
///
/// The dWallet's authority must already be transferred to this program's
/// CPI authority PDA (seeds: `[b"__ika_cpi_authority"]`). That's a separate
/// `transfer_dwallet` step driven by the relayer after DKG.
///
/// Use case in Predacy:
///   - Cross-chain Polymarket signing — the `message_digest` is the hash of
///     a Polygon transaction that our user's Secp256k1 dWallet should sign.
///     Architecture §5 (Liquidity & counterparty model).
///
/// Signature schemes (per Ika's `DWalletSignatureScheme` enum):
///   0 = EcdsaKeccak256 (Polygon / EVM)
///   1 = EcdsaSha256
///   2 = EcdsaDoubleSha256
///   3 = TaprootSha256
///   4 = EcdsaBlake2b256
///   5 = EddsaSha512 (Solana)
///   6 = SchnorrkelMerlin
#[derive(Accounts)]
pub struct ApproveIkaMessage<'info> {
    /// The Ika dWallet program. Identified by address to prevent confused-deputy
    /// attacks — only the real Ika program can be invoked.
    /// CHECK: address verified via #[account(address = ...)]. The Ika program
    /// is invoked via CPI; no data reads from this account.
    #[account(address = ika_program_id::ID)]
    pub ika_program: UncheckedAccount<'info>,

    /// Ika's DWalletCoordinator PDA (seeds: [b"dwallet_coordinator"] in Ika's program).
    /// Read-only — the Ika program reads the current epoch from it.
    /// CHECK: PDA derivation enforced by the Ika program's internal validation.
    pub ika_coordinator: UncheckedAccount<'info>,

    /// The MessageApproval PDA to create. Seeds are enforced by Ika's
    /// approve_message validation on its end — we pass it as an unchecked
    /// account writable. Ika will init it with status=Pending.
    /// CHECK: initialized by the Ika program via CPI.
    #[account(mut)]
    pub message_approval: UncheckedAccount<'info>,

    /// The dWallet account (created via DKG). Authority must be our CPI PDA.
    /// CHECK: authority check enforced by Ika's approve_message.
    pub dwallet: UncheckedAccount<'info>,

    /// Our program's CPI authority PDA. Ika's program verifies this is a
    /// signer derived from our program's ID + the canonical seed.
    /// CHECK: PDA verified by seeds constraint + Ika's verify_signer_or_cpi.
    #[account(
        seeds = [CPI_AUTHORITY_SEED],
        bump,
    )]
    pub cpi_authority: UncheckedAccount<'info>,

    /// Our own program, required by Ika's CPI validation to prove the caller.
    /// CHECK: address verified against the declared program ID.
    #[account(address = crate::ID)]
    pub predacy_program: UncheckedAccount<'info>,

    /// Pays rent for the newly-created MessageApproval PDA.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// The Ika dWallet program ID on devnet Pre-Alpha.
/// Wrapped in a module so we can use #[account(address = ...)] syntax.
pub mod ika_program_id {
    use anchor_lang::prelude::*;
    declare_id!("87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY");
}

pub fn handler(
    ctx: Context<ApproveIkaMessage>,
    message_digest: [u8; 32],
    message_metadata_digest: [u8; 32],
    user_pubkey: [u8; 32],
    signature_scheme: u16,
    message_approval_bump: u8,
) -> Result<()> {
    let cpi_ctx = DWalletContext {
        dwallet_program: ctx.accounts.ika_program.to_account_info(),
        cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
        caller_program: ctx.accounts.predacy_program.to_account_info(),
        cpi_authority_bump: ctx.bumps.cpi_authority,
    };

    cpi_ctx.approve_message(
        &ctx.accounts.ika_coordinator.to_account_info(),
        &ctx.accounts.message_approval.to_account_info(),
        &ctx.accounts.dwallet.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        message_digest,
        message_metadata_digest,
        user_pubkey,
        signature_scheme,
        message_approval_bump,
    )?;

    msg!("Predacy approved Ika message for dWallet {}", ctx.accounts.dwallet.key());
    Ok(())
}
