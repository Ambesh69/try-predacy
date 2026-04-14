use anchor_lang::prelude::*;

use crate::constants::MAX_COMMITMENTS;

// ─── Enums ───

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum BatchStatus {
    Open,
    Settling,
    Locked,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OrderSide {
    YesBuy,
    YesSell,
    NoBuy,
    NoSell,
}

impl OrderSide {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(OrderSide::YesBuy),
            1 => Some(OrderSide::YesSell),
            2 => Some(OrderSide::NoBuy),
            3 => Some(OrderSide::NoSell),
            _ => None,
        }
    }

    pub fn is_buy(&self) -> bool {
        matches!(self, OrderSide::YesBuy | OrderSide::NoBuy)
    }

    pub fn is_yes(&self) -> bool {
        matches!(self, OrderSide::YesBuy | OrderSide::YesSell)
    }
}

// ─── Protocol Config (Singleton) ───

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub batch_window_secs: u64,
    pub max_orders_per_batch: u16,
    pub bump: u8,
}

// ─── Market ───

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub market_id: [u8; 32],
    pub authority: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub yes_vault: Pubkey,
    pub no_vault: Pubkey,
    pub current_batch_index: u64,
    pub resolved: bool,
    pub outcome: u8, // 0 = unresolved, 1 = YES, 2 = NO
    pub bump: u8,
}

// ─── Batch ───

#[account]
#[derive(InitSpace)]
pub struct Batch {
    pub market_id: [u8; 32],
    pub batch_index: u64,
    pub status: u8, // BatchStatus as u8
    pub opened_at: i64,
    pub closed_at: i64,
    // Running totals from commit time
    pub total_deposited: u64,     // USDC from all BUY orders (side hidden)
    pub total_sell_yes: u64,      // YES tokens deposited by sellers
    pub total_sell_no: u64,       // NO tokens deposited by sellers
    // Settlement results (set during lock_funds)
    pub clearing_price: u64,      // 6-decimal fixed point
    pub commitment_count: u16,
    pub commitment_root: [u8; 32],     // Sequential hash for ZK batch proof
    pub claim_merkle_root: [u8; 32],   // Binary Merkle tree for claim proofs
    // Filled volumes
    pub filled_yes_buy_vol: u64,
    pub filled_no_buy_vol: u64,
    pub filled_yes_sell_qty: u64,
    pub filled_no_sell_qty: u64,
    // Gaps for CLOB fill
    pub yes_gap: u64,
    pub no_gap: u64,
    pub final_excess_yes: u64,
    pub final_excess_no: u64,
    // Claimed bitmap (supports up to 64 orders — sufficient for circuit's 8-order limit)
    pub claimed_bitmap: u64,
    pub bump: u8,
}

impl Batch {
    pub fn status(&self) -> BatchStatus {
        match self.status {
            0 => BatchStatus::Open,
            1 => BatchStatus::Settling,
            2 => BatchStatus::Locked,
            3 => BatchStatus::Settled,
            _ => BatchStatus::Open, // fallback
        }
    }

    pub fn is_claimed(&self, index: u16) -> bool {
        self.claimed_bitmap & (1u64 << index) != 0
    }

    pub fn mark_claimed(&mut self, index: u16) {
        self.claimed_bitmap |= 1u64 << index;
    }
}

// ─── Commitment Store (Zero-Copy, per batch) ───

#[account(zero_copy)]
#[repr(C)]
pub struct CommitmentStore {
    pub count: u32,
    pub _padding: [u8; 4],
    pub commitments: [CommitmentEntry; MAX_COMMITMENTS],
}

#[zero_copy]
#[repr(C)]
pub struct CommitmentEntry {
    pub hash: [u8; 32],
    pub amount: u64,
}

// ─── Nullifier (one PDA per claim, existence = used) ───

#[account]
#[derive(InitSpace)]
pub struct Nullifier {
    pub bump: u8,
}
