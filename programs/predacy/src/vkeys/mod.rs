//! Groth16 verifying keys for the batch_clearing and claim circuits.
//!
//! Generated from `circuits/setup/*_vkey.json` via
//! https://github.com/Lightprotocol/groth16-solana/blob/master/parse_vk_to_rust.js
//!
//! Used by instructions/settle_batch.rs (batch) and instructions/claim_with_proof.rs (claim).
//!
//! Regenerate after changing the circuits with:
//!   cd /tmp && mkdir -p g16h && cd g16h
//!   curl -sL https://raw.githubusercontent.com/Lightprotocol/groth16-solana/master/parse_vk_to_rust.js -o parse.js
//!   npm i ffjavascript
//!   node parse.js <project>/circuits/setup/batch_clearing_vkey.json && mv verifying_key.rs batch_vk.rs
//!   node parse.js <project>/circuits/setup/claim_vkey.json && mv verifying_key.rs claim_vk.rs
//!   # then copy batch_vk.rs → programs/predacy/src/vkeys/batch.rs (rename const to BATCH_VK)
//!   #      claim_vk.rs → programs/predacy/src/vkeys/claim.rs (rename const to CLAIM_VK)

pub mod batch;
pub mod claim;
pub mod test;

pub use batch::BATCH_VK;
pub use claim::CLAIM_VK;
pub use test::{TEST_PROOF_A, TEST_PROOF_B, TEST_PROOF_C, TEST_PUBLIC_INPUTS, TEST_VK};
