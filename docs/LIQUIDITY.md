# Predacy Liquidity Stack — Design Doc

**Status:** active build. Path A (ship-everything), 3-week budget.
**Last revised:** 2026-04-26.

## 1. Goals

- Bootstrap any new prediction market with **zero LP capital up front** and zero cold-start UX failure.
- Provide a real LP role with **passive yield**, not a treasury subsidy disguised as one.
- Make the actual mechanism design defensible: privacy-blinded LP positions via FHE — a feature **no other prediction market today offers**.
- Generalise the same primitive across multiple verticals (poker first, sports / crypto / politics next), not poker-only.

## 2. Non-goals

- Continuous quoting (CLOB style). Predacy is sealed-bid batch — that's the point.
- Permissionless market creation (à la Worm/Melee). Markets are operator-curated for v1.
- Native LP token. v1 economics are closed-loop on taker fees; token incentives can come later.

## 3. The Stack — three tiers

```
┌──────────────────────────────────────────────────────────────────┐
│  TIER 2 — Maker Rebates                                          │
│  Active retail. Sealed-bid limit orders that absorb taker flow   │
│  earn pro-rata share of accumulated taker fees.                  │
├──────────────────────────────────────────────────────────────────┤
│  TIER 1 — Blind LP Pool (FHE-encrypted positions)                │
│  Passive depth. Anyone deposits USDC for an `EventHandle`,       │
│  earns rebate share + spread, position size FHE-blinded so       │
│  inventory direction never leaks. Auto-refunds at event end.     │
├──────────────────────────────────────────────────────────────────┤
│  TIER 0 — Bootstrap Pool (LMSR curve, protocol-funded)           │
│  Cold-start safety net. Each `EventHandle` allocates ~$50-200    │
│  of protocol capital running an LS-LMSR curve. Fills residual    │
│  gap when retail is one-sided. Bounded loss `b × ln(2)` per      │
│  binary market. Steps back once Tier 1 capital activates.        │
└──────────────────────────────────────────────────────────────────┘
```

### Settlement order per batch

1. **Match retail-vs-retail at clearing price** (existing pairMatcher).
2. **Compute residual imbalance.** `residual_yes_buy_demand − filled_pair_qty`, etc.
3. **If pre-graduation OR Tier 1 capital insufficient: pull from Tier 0** at LMSR curve price.
4. **If post-graduation: pull from Tier 1** at clearing price; Tier 1 absorbs directional exposure into the encrypted pool.
5. **Compute taker fees on filled volume.** Split: 10 bps protocol-treasury, 20 bps to maker rebate pool.
6. **Allocate maker rebate credits** (Tier 2) to limit orders that absorbed taker volume, weighted by `volume × distance_from_mid`.

Graduation gate: `≥2 retail-only batches with ≥$500 cumulative volume each` before Tier 1 backstop activates.

## 4. EventHandle — the unit of LP commitment

LPs commit by **event**, not by individual market. One `EventHandle` covers all markets under it (a poker stream covers ~50 hand-by-hand markets; a tournament series covers per-day winner markets; etc.).

```rust
#[account]
pub struct EventHandle {
    pub handle_id: [u8; 32],          // hash("hcl-2026-04-29")
    pub category: u8,                 // 0=LiveStream 1=Sports 2=Crypto 3=Custom
    pub authority: Pubkey,            // operator who can close/refund
    pub created_at: i64,
    pub closes_at: i64,               // auto-refund triggered after this
    pub graduation_threshold_usdc: u64,
    pub graduation_batches: u8,       // 2
    pub fee_bps_taker: u16,           // 30
    pub fee_bps_treasury: u16,        // 10
    pub fee_bps_rebates: u16,         // 20
    pub bootstrap_seed_usdc: u64,     // 100_000_000 = $100
    pub bump: u8,
}
```

A market is created **under** an EventHandle, inheriting its fee/graduation params. EventHandle PDA seeds: `[b"event", &handle_id]`.

## 5. New on-chain accounts (predacy program)

### 5.1 BootstrapPool (Tier 0)

```rust
#[account]
pub struct BootstrapPool {
    pub market_id: [u8; 32],
    pub event_handle: Pubkey,
    pub seed_usdc: u64,           // initial capital, protocol-funded
    pub current_q: u64,           // total collateral in pool
    pub b_param: u64,             // LS-LMSR liquidity parameter
    pub yes_shares: u64,          // outstanding YES
    pub no_shares: u64,           // outstanding NO
    pub graduated: bool,          // true once Tier 1 takes over
    pub realized_pnl: i64,        // signed; recovered at market resolution
    pub bump: u8,
}
```

PDA: `[b"bootstrap", &market_id]`. LMSR cost function: `C(q_yes, q_no) = b * ln(exp(q_yes/b) + exp(q_no/b))`. Computed off-chain by the relayer (proof-bounded), state mutation on-chain enforces conservation.

### 5.2 LPVault + LPPosition (Tier 1)

```rust
#[account]
pub struct LPVault {
    pub event_handle: Pubkey,
    pub total_capital_usdc: u64,           // public aggregate
    pub total_shares: u64,                 // virtual share count
    pub realized_yes_position: i64,        // signed net inventory (plaintext for v1)
    pub realized_no_position: i64,
    pub fhe_encrypted_state: [u8; 1024],   // reserved for Tier 1 v2 (ciphertext blob)
    pub bump: u8,
}

#[account]
pub struct LPPosition {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub shares_plaintext: u64,             // v1 — public balance
    pub fhe_shares_ct: [u8; 64],           // v2 — encrypted balance under Predacy FHE key
    pub deposited_at: i64,
    pub commitment_expires_at: i64,        // auto-refund cutoff
    pub bump: u8,
}
```

PDA seeds: `[b"lpvault", event_handle.as_ref()]`, `[b"lppos", vault.as_ref(), depositor.as_ref()]`.

### 5.3 MakerRebatePool + MakerCredit (Tier 2)

```rust
#[account]
pub struct MakerRebatePool {
    pub event_handle: Pubkey,
    pub accrued_taker_fees_usdc: u64,
    pub total_credits: u64,                // sum of all maker_credits this event
    pub closed: bool,                      // true at event end
    pub bump: u8,
}

#[account]
pub struct MakerCredit {
    pub pool: Pubkey,
    pub maker: Pubkey,
    pub credit: u64,                       // accumulated over event
    pub claimed: bool,
    pub bump: u8,
}
```

Maker credit per fill: `volume * (1 + distance_from_mid_bps / 100)`. Tighter quotes earn disproportionately more — same shape Limitless uses.

## 6. New instructions (predacy program)

| Instruction | Purpose | Sprint |
|---|---|---|
| `create_event_handle(handle_id, category, ...params)` | Operator creates an event with its fee/graduation params | 1.1 |
| `init_bootstrap_pool(seed_usdc, b_param)` | Protocol seeds Tier 0 for a market under an event | 1.2 |
| `bootstrap_fill(market, side, qty, price)` | Relayer-driven fill against Tier 0 LMSR curve | 1.2 |
| `commit_lp_capital(event_handle, amount, expiry)` | LP deposits USDC into Tier 1 vault | 1.3 |
| `lp_settle_batch(vault, batch, residual_yes, residual_no)` | Per-batch state mutation absorbing residual into vault | 1.3 |
| `withdraw_lp_capital(position)` | LP withdraws shares + earnings after expiry | 1.3 |
| `init_rebate_pool(event_handle)` | Initialises Tier 2 accumulator for event | 1.4 |
| `accrue_maker_credit(pool, maker, credit)` | Relayer credits maker per fill | 1.4 |
| `claim_maker_rebate(credit)` | Maker withdraws their pro-rata share at event end | 1.4 |

## 7. Tier 1 FHE upgrade (Sprint 2)

v1 ships Tier 1 with **plaintext** `shares_plaintext` in `LPPosition` — visible balances, no privacy.

v2 swaps to FHE-encrypted `fhe_shares_ct`:

- Deposit: relayer encrypts `shares_delta` under Predacy's FHE pubkey, calls `commit_lp_capital_fhe`. On-chain stores ciphertext.
- Per-batch settlement: `predacy-fhe` program runs FHE addition on aggregate vault state to update encrypted balances. Public aggregate (`total_capital_usdc`) stays plaintext for transparency; per-LP shares stay encrypted.
- Withdraw: relayer decrypts the LP's own ciphertext (only that LP's share, not others'), proves correctness via Groth16, calls `withdraw_lp_capital_fhe` with payout amount + proof.

**Constraint:** Encrypt's pre-Alpha SDK supports one-shot FHE clearing per batch. Persistent encrypted state across batches is unproven on their side. Sprint 2 starts with a feasibility test against `pre-alpha-dev-1.encrypt.ika-network.net:443` — if persistent state isn't supported, we ship plaintext Tier 1 and frame FHE as "Encrypt Alpha 1 forward-compatible" (same playbook as Ika).

The on-chain account layout above already reserves space (`fhe_encrypted_state[1024]`, `fhe_shares_ct[64]`) so the v2 upgrade is a no-redeploy swap.

## 8. Off-chain changes (relayer)

### 8.1 LPRegistry.ts — repurpose

Currently models a Polygon-bridge USDC market. Reframe as the **client-side index** of Tier 1 + Tier 2 participants:

- `reserveCapital()` now picks Tier 1 LP shares to absorb residual, not Polygon LPs to fund Polymarket round-trips
- Existing `feeBps` field maps to LP rebate share
- Polymarket-bridge logic moves into a separate `bridgeRouter.ts` module that's only invoked when a market has a Polymarket equivalent (mainnet only)

### 8.2 batchProcessor.ts — settlement order

After `computePairMatching()`, before `routeResiduals()`:

1. Compute residual = pair-matching outputs
2. If `event.graduated == false`: residual fills against Tier 0 LMSR (call `bootstrap_fill` ix)
3. Else: residual fills against Tier 1 LP vault (call `lp_settle_batch` ix)
4. Per-batch maker credits computed from fills, batched into `accrue_maker_credit` calls

### 8.3 New: bootstrapCurve.ts

LS-LMSR pricing module: given `(b, q_yes, q_no)`, return marginal price for buying `Δq` of either side. Used by relayer to compute Tier 0 fill prices before submitting `bootstrap_fill`.

### 8.4 New: lpAccountant.ts

Tracks per-event accruals: vault deposits, residual fills, maker credits, payout amounts. Single source of truth for the `/lp/earnings` API endpoint.

## 9. Frontend changes

- **LP page** (`/lp`): list of active EventHandles with their TVL, expected APY (rebate share / volume / commit duration), deposit form, my-positions panel
- **Event picker**: when creating market, pick existing EventHandle or create new
- **Settlement breakdown**: existing settlement UI grows a "Backed by The Stack — Tier 0 $X · Tier 1 $Y · N makers" line per batch

## 10. Sprints (3 weeks)

### Week 1 — On-chain primitives + relayer wiring
- 1.1 (1d) EventHandle account + `create_event_handle` ix
- 1.2 (3d) BootstrapPool + LMSR + `init_bootstrap_pool`/`bootstrap_fill`; relayer `bootstrapCurve.ts`
- 1.3 (3d) LPVault + LPPosition + commit/settle/withdraw (plaintext Tier 1)
- 1.4 (2d) Rebate pool + accrual + claim
- 1.5 (1d) Wire batch processor to call new ix in correct order

### Week 2 — FHE Blind LP + integration
- 2.1 (2d) Feasibility test: persistent FHE state on Encrypt pre-Alpha
- 2.2 (3d) Extend predacy-fhe with LP-state ops; on-chain encrypted balance fields
- 2.3 (2d) Relayer encrypt/decrypt for deposit/withdraw
- 2.4 (1d) FHE bypass switch (env flag) for graceful degradation

### Week 3 — Frontend, demo, polish
- 3.1 (3d) `/lp` page + earnings dashboard + event picker
- 3.2 (2d) Demo poker market (HCL Wednesday) end-to-end with real LP capital
- 3.3 (2d) Record video, write README + submission pitch

## 11. Acceptance criteria (must hit by week 3)

- Brand-new market with zero deposited LP capital can clear a one-sided batch via Tier 0
- LP can deposit USDC under an EventHandle, capital absorbs residuals across multiple batches, withdrawal returns deposit + earnings within 1 tx after event close
- Maker who places a non-marketable limit order that absorbs taker flow can claim a rebate proportional to their credit
- `/health` adds `liquidityStack: { tier0Pools: N, tier1Vaults: M, totalLPCapital: $X }`
- README has a "Liquidity Stack" section explaining the design + the FHE moat
- Demo video shows: LP deposit → poker market opens → 5+ batches settle with mixed Tier 0 + Tier 1 fills → LP withdraws with earnings → maker claims rebate

## 12. Open questions

1. **LMSR `b` parameter calibration.** $100 seed → b ≈ 144. Worst-case loss ≈ $100 per market. Acceptable?
2. **Tier 1 commitment minimum.** $50? $500? Below $50 the gas of deposit/withdraw eats yields.
3. **Cross-event LP shares.** Should an LP be able to commit one $10k pool that fans out across N concurrent EventHandles? Probably yes for v2; v1 is per-event.
4. **Slashing.** If Tier 1 LP fails some commitment (which they can't really, since the vault auto-fills) — do we need slashing primitives? Current answer: no, the vault is the protocol-controlled actor, not the LP individually.
5. **Outcome-time payouts.** When market resolves, who decrypts the FHE LP positions to compute payouts? The relayer holds the FHE secret key — same trust model as the rest of `predacy-fhe`. Document this clearly.
