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

// ─── EventHandle (Liquidity Stack — see docs/LIQUIDITY.md §4) ───
//
// Unit of LP commitment. One EventHandle covers many markets:
//   - "hcl-2026-04-29"                → all hand-by-hand markets in tonight's HCL stream
//   - "triton-vegas-100k-day1"        → all markets for that tournament day
//   - "btc-15min-window-2026-04-26-T" → 96 daily 15-min crypto markets
//
// LPs commit capital under a handle, not per market. Capital auto-refunds at
// `closes_at`. Fee/graduation params are inherited by every market under the
// handle. A market reads its handle's params when computing settlement.

// Discriminants are implicit and sequential (0..=4) — keep this match
// in sync with from_u8 below if order changes. Order is ABI-stable.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EventCategory {
    LiveStream, // 0 — Poker streams, esports tournaments, talk shows
    Sports,     // 1 — Match-scale event markets
    Crypto,     // 2 — 15-min / hourly / daily price windows
    Politics,   // 3 — Day-to-week scale resolution
    Custom,     // 4 — Operator-defined
}

impl EventCategory {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(EventCategory::LiveStream),
            1 => Some(EventCategory::Sports),
            2 => Some(EventCategory::Crypto),
            3 => Some(EventCategory::Politics),
            4 => Some(EventCategory::Custom),
            _ => None,
        }
    }
}

// ─── BootstrapPool (Liquidity Stack — Tier 0, see docs/LIQUIDITY.md §5.1) ───
//
// Per-market LS-LMSR curve providing cold-start liquidity. Operator seeds
// `seed_usdc` of protocol capital; pool quotes both YES and NO shares
// against retail demand until Tier 1 capital activates ("graduated"). After
// graduation, bootstrap_fill rejects further fills and the residual flow
// goes to the Blind LP vault instead.
//
// LMSR math is computed off-chain by the relayer (see relayer/src/
// bootstrapCurve.ts); on-chain we just track state transitions and enforce
// invariants. The relayer's authority signature gates the fill ix.

#[account]
#[derive(InitSpace)]
pub struct BootstrapPool {
    /// Identifies the market this pool backstops.
    pub market_id: [u8; 32],
    /// EventHandle this pool was created under — for fee/graduation params.
    pub event_handle: Pubkey,
    /// Seed capital, 6-decimal USDC. Set once at init, immutable.
    pub seed_usdc: u64,
    /// Total collateral currently in the pool: seed + accrued buy-side
    /// USDC − payouts. 6-decimal USDC.
    pub current_q: u64,
    /// LS-LMSR `b` parameter. Recomputed on each fill as α × current_q
    /// where α = LMSR_ALPHA_BPS / 10_000. Storing it explicitly so the
    /// off-chain pricer doesn't have to recompute it.
    pub b_param: u64,
    /// Outstanding YES shares (1 share = 1 USDC if YES wins). 6-decimal.
    pub yes_shares: u64,
    /// Outstanding NO shares. 6-decimal.
    pub no_shares: u64,
    /// Set by the relayer once the market hits the graduation threshold
    /// (≥2 batches × ≥graduation_threshold_usdc). After this, bootstrap_fill
    /// rejects all calls — Tier 1 LP vault takes over.
    pub graduated: bool,
    /// Cumulative realized pnl on closed positions, signed. Resolved at
    /// market resolution by `redeem_outcome` flow.
    pub realized_pnl: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EventHandle {
    /// 32-byte stable id, e.g. blake3(canonical_event_label).
    pub handle_id: [u8; 32],
    /// EventCategory, encoded as u8 for ABI stability.
    pub category: u8,
    /// Operator who can close/refund the event early.
    pub authority: Pubkey,
    pub created_at: i64,
    /// Unix seconds. Tier 1 LP capital auto-refunds after this timestamp.
    pub closes_at: i64,
    /// Cumulative volume across batches this event must hit before
    /// graduation (Tier 1 backstop activates).
    pub graduation_threshold_usdc: u64,
    /// Number of consecutive batches that each must clear at least
    /// graduation_threshold_usdc / graduation_batches volume.
    pub graduation_batches: u8,
    /// Fee bps charged on filled volume by takers. Default 30.
    pub fee_bps_taker: u16,
    /// Of the taker fee, this slice goes to protocol treasury. Default 10.
    pub fee_bps_treasury: u16,
    /// Of the taker fee, this slice funds the maker-rebate pool. Default 20.
    pub fee_bps_rebates: u16,
    /// Bootstrap-pool seed in 6-decimal USDC. Protocol-funded per market
    /// under this handle. Default 100_000_000 = $100.
    pub bootstrap_seed_usdc: u64,
    /// Set to true once the operator closes the event. Triggers refund flow.
    pub closed: bool,
    pub bump: u8,
}
