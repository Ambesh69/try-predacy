use anchor_lang::prelude::*;

#[event]
pub struct BatchOpened {
    pub market_id: [u8; 32],
    pub batch_index: u64,
    pub opened_at: i64,
}

#[event]
pub struct OrderCommitted {
    pub batch_index: u64,
    pub commitment_hash: [u8; 32],
    pub commitment_index: u16,
    pub amount: u64,
}

#[event]
pub struct BatchClosed {
    pub batch_index: u64,
    pub commitment_count: u16,
    pub closed_at: i64,
}

#[event]
pub struct FundsLocked {
    pub batch_index: u64,
    pub clearing_price: u64,
    pub filled_yes_buy_vol: u64,
    pub filled_no_buy_vol: u64,
    pub filled_yes_sell_qty: u64,
    pub filled_no_sell_qty: u64,
    pub yes_gap: u64,
    pub no_gap: u64,
}

#[event]
pub struct BatchSettled {
    pub batch_index: u64,
    pub claim_merkle_root: [u8; 32],
}

#[event]
pub struct ClaimProcessed {
    pub batch_index: u64,
    pub nullifier: [u8; 32],
    pub side: u8,
    pub filled_amount: u64,
    pub refund_amount: u64,
}

#[event]
pub struct MarketResolved {
    pub market_id: [u8; 32],
    pub outcome: u8,
}

#[event]
pub struct OutcomeRedeemed {
    pub market_id: [u8; 32],
    pub amount: u64,
    pub recipient: Pubkey,
}
