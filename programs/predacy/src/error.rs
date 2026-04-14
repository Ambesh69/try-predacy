use anchor_lang::prelude::*;

#[error_code]
pub enum PredacyError {
    #[msg("Batch is not in the expected status")]
    InvalidBatchStatus,
    #[msg("Batch window has not elapsed yet")]
    BatchWindowNotElapsed,
    #[msg("Batch window has already elapsed")]
    BatchWindowElapsed,
    #[msg("Maximum number of orders reached for this batch")]
    MaxOrdersReached,
    #[msg("Commitment hash mismatch")]
    CommitmentMismatch,
    #[msg("Invalid order side")]
    InvalidOrderSide,
    #[msg("Invalid clearing price")]
    InvalidClearingPrice,
    #[msg("Nullifier already used — double claim attempt")]
    NullifierAlreadyUsed,
    #[msg("ZK proof verification failed")]
    ProofVerificationFailed,
    #[msg("Market already resolved")]
    MarketAlreadyResolved,
    #[msg("Market not resolved yet")]
    MarketNotResolved,
    #[msg("Invalid outcome for redemption")]
    InvalidOutcome,
    #[msg("Order already claimed")]
    AlreadyClaimed,
    #[msg("Rescue delay not elapsed — must wait 7 days")]
    RescueDelayNotElapsed,
    #[msg("Unauthorized — caller is not the authority")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Insufficient vault balance")]
    InsufficientBalance,
    #[msg("Invalid market ID")]
    InvalidMarketId,
    #[msg("Batch does not belong to this market")]
    BatchMarketMismatch,
}
