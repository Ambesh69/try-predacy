use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

use crate::error::PredacyError;
use crate::vkeys::{BATCH_VK, TEST_PROOF_A, TEST_PROOF_B, TEST_PROOF_C, TEST_PUBLIC_INPUTS, TEST_VK};

/// Discriminator / debug instruction. Two modes:
///
///   mode=0 (canonical): run groth16-solana's own test vectors against
///                       their test VK. Known-good bytes. If this fails,
///                       the devnet syscall itself is broken.
///
///   mode=1 (user-supplied against BATCH_VK): caller passes proof bytes and
///                       7 public-input bytes; we run against OUR committed
///                       batch vkey. Lets us iterate on encoding without
///                       redeploying the whole program.
///
/// Arguments only used in mode=1.
#[derive(Accounts)]
pub struct VerifyTestVectors {}

pub fn handler(
    _ctx: Context<VerifyTestVectors>,
    mode: u8,
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    pub_inputs: [[u8; 32]; 7],
) -> Result<()> {
    match mode {
        0 => {
            msg!("mode=0: canonical groth16-solana test vectors against TEST_VK");
            let mut v = Groth16Verifier::new(
                &TEST_PROOF_A,
                &TEST_PROOF_B,
                &TEST_PROOF_C,
                &TEST_PUBLIC_INPUTS,
                &TEST_VK,
            ).map_err(|e| { msg!("new err: {:?}", e); PredacyError::ProofVerificationFailed })?;
            v.verify().map_err(|e| { msg!("verify err: {:?}", e); PredacyError::ProofVerificationFailed })?;
            msg!("✓ mode=0 passed — syscall OK");
            Ok(())
        }
        1 => {
            msg!("mode=1: user proof bytes against BATCH_VK");
            let mut v = Groth16Verifier::new(
                &proof_a,
                &proof_b,
                &proof_c,
                &pub_inputs,
                &BATCH_VK,
            ).map_err(|e| { msg!("new err: {:?}", e); PredacyError::ProofVerificationFailed })?;
            v.verify().map_err(|e| { msg!("verify err: {:?}", e); PredacyError::ProofVerificationFailed })?;
            msg!("✓ mode=1 passed — user bytes verify against BATCH_VK");
            Ok(())
        }
        _ => {
            msg!("unknown mode: {}", mode);
            Err(PredacyError::ProofVerificationFailed.into())
        }
    }
}
