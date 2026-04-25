# Predacy — Architecture

Private sealed-bid batch auctions for prediction markets on Solana, routed to Polymarket CLOB liquidity via Ika MPC.

---

## 1. What we're actually hiding

Predacy is a dark-pool prediction market. Three things are kept private, against three different threat models:

| Property             | What's hidden                               | From whom                              | Mechanism                                       |
| -------------------- | ------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| **Order contents**   | Side, size, limit price                     | Everyone, including the relayer        | FHE (Encrypt) + Poseidon commitment + Groth16   |
| **Trader identity**  | Link from Alice's main wallet to her orders | Any on-chain observer (Solana + Polygon) | Umbra shielded pool + ephemeral keypair + Ika dWallet |
| **Pre-trade info**   | Whether an order exists at all              | Other traders during the batch window  | Sealed-bid 30s batch, revealed only in aggregate |

The goal isn't "unconditional privacy." It's **"no single party can deanonymize or observe an Alice-to-order link"** — the same standard Railgun + commit-reveal provides on Polygon, extended with FHE so even the relayer can't see order contents.

---

## 2. Threat model — what we protect against

Predacy defends against:

- **Chain analysts and MEV bots** watching Solana transactions and PDAs, or watching Polymarket orders on Polygon.
- **Other traders** trying to front-run or copy orders during the batch window.
- **The relayer itself** trying to reconstruct order details (FHE-protected during the batch window).
- **Competitors and counterparties** correlating on-chain positions to a real identity.

One-liner: **on-chain, Alice is unlinked from her orders across both chains, and no party — not even the relayer — sees her order contents in real time.**

---

## 3. The privacy stack — four independent layers

Organized around **what's hidden**, not by ISO-layer ordering:

```
┌────────────────────────────────────────────────────────────────────┐
│  WHAT YOU'RE TRADING (order contents)                              │
│  ├─ FHE at relayer (Encrypt REFHE) — sealed window + price discovery│
│  ├─ Groth16 on-chain — settle proof hides individual orders        │
│  └─ Sealed-bid 30s batch — other traders see nothing until routing │
├────────────────────────────────────────────────────────────────────┤
│  WHO YOU ARE (identity-to-order link)                              │
│  ├─ Ika dWallet — one MPC key signs on Solana AND Polygon          │
│  ├─ Ephemeral keypair — fresh on-chain identity per order           │
│  └─ Umbra shielded pool — funding flow amount + graph hidden       │
└────────────────────────────────────────────────────────────────────┘
```

Each layer is independent. If any one is broken, the others still provide meaningful privacy. Defense-in-depth: FHE protects order contents within the sealed-bid window, Ika gives cross-chain unlinkability, ephemeral keypairs + Umbra hide the funding flow.

---

## 4. Key material — who holds what

| Key                    | Purpose                                                                                     | Owner / location                                                |
| ---------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Main wallet**        | User identity on Solana, USDC holdings, optional unwrap destination                         | Alice's Privy-managed Solana wallet (or self-custody)           |
| **Ika dWallet**        | 2PC-MPC key signing on both Solana and Polygon; orchestrates atomic cross-chain flows       | 2PC-MPC between Alice's client and Ika network                  |
| **Ephemeral keypair**  | On-chain identity for a single order / position                                             | Generated client-side, **in-memory only**, one per order        |
| **Relayer keypair**    | Pays Solana fees for ephemeral-signed txs (fee sponsorship); orchestrates batches           | Relayer server (`~/.config/solana/id.json`)                     |
| **FHE public key**     | Encryption target for order plaintext; relayer can compute but not decrypt during window    | Published by Encrypt protocol, rotated per batch                |
| **LP Polygon keys**    | Liquidity providers who pre-fund Polygon USDC to enable bridgeless atomic swaps             | Independent LP entities (yield-seeking market makers)           |

**Why Ika?** Alice's main wallet never has to sign the per-order commit transaction directly. More critically, the **same Ika key can sign on Polygon** — enabling atomic cross-chain flows (Solana USDC → LP → Polymarket mint → Polygon YES/NO tokens) without bridges. No trust, no waiting, no Predacy float.

**Why in-memory ephemeral?** If Alice's device is compromised, a persisted ephemeral secret could be recovered and correlated to her past orders. Holding ephemeral keys in memory only means there's nothing to recover after the session ends.

**Why LPs?** Polymarket lives on Polygon; users shield USDC on Solana. Rather than bridge funds (slow) or hold operational float (capital-intensive), Predacy taps a market of yield-seeking LPs who provide Polygon USDC instantly in exchange for a small fee. Ika MPC enforces atomicity, so LPs bear no counterparty risk.

---

## 5. Liquidity & counterparty model

**Predacy holds zero inventory and takes zero counterparty risk.** All liquidity comes from Polymarket's CLOB and complete-set mint primitives. Predacy is a dark-pool wrapper around Polymarket, not a self-contained market maker.

### 5.1 Why no vault

If Predacy matched orders internally (Alice's $0.58 YES buy against Bob's $0.58 YES sell), it would have to source the shares Bob is "selling" — meaning it either needs existing inventory or has to front-run the risk. That's vault-balance territory, and it's the exact solvency problem that kills custodial prediction markets at scale.

Instead, every trade is ultimately backed by Polymarket's reserves:

- **Complete-set mints** (for complementary pairs): Polymarket's CTF contract mints 1 YES + 1 NO for $1. Balanced by construction, fully reserved, zero Predacy liability.
- **CLOB orders** (for residuals): Polymarket's matching engine pairs the order against existing book liquidity. Predacy is a passthrough.

### 5.2 Two execution paths per batch

At batch close, FHE clearing identifies two classes of orders:

| Class                     | Execution                                                              | Who provides liquidity       |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| **Complementary pairs**   | Polymarket complete-set mint at FHE-computed batch clearing price P    | Polymarket CTF mint contract |
| **Residual orders**       | Individual Polymarket CLOB limit orders at user's original limit price | Polymarket book makers       |

Complementary pairs preserve the uniform-price batch-auction guarantee (all matched traders execute at the same price P). Residuals get Polymarket CLOB prices, same as any retail Polymarket trader.

### 5.3 Cross-chain coordination via Ika + LPs

The problem: Alice's USDC sits on Solana (shielded in Umbra). Polymarket mints and CLOB orders require USDC on Polygon. These are different dollars on different chains.

Solution: **Ika-orchestrated atomic swaps with LP-provided Polygon liquidity.**

```
For a matched pair (Alice + Bob):

  Ika MPC coordinates a single atomic operation:
  ┌─ Unlock Alice's $0.58 from Umbra → LP's Solana address
  ├─ Unlock Bob's $0.42 from Umbra → LP's Solana address
  ├─ LP releases $1.00 on Polygon → Polymarket complete-set mint
  ├─ Polymarket mints 1 YES + 1 NO
  ├─ Ika signs distributions: YES → Alice's Ika-Polygon addr; NO → Bob's
  └─ All steps atomic. If any fail, all revert.
```

**Key property**: LPs earn a small fee (e.g., 5bps) for providing instant Polygon USDC. Their capital is never at risk — Ika MPC enforces atomicity. If the Solana-side unlocks fail, the Polygon-side release reverts automatically. Same model as intent-based bridges (Across, 1inch Fusion, CoW) — just applied to Predacy's prediction market flow.

**What this achieves**:
- **Zero Predacy operational capital** — LPs provide the Polygon USDC
- **Zero LP counterparty risk** — Ika MPC guarantees atomicity
- **Fast UX** — no bridge wait times; atomic completion in seconds
- **Privacy preserved** — Alice's main wallet never appears on Polygon

### 5.4 Two latency concepts (important UX nuance)

**Submit latency** = time from clicking "Place order" to being in a batch.
  Always ~instant (one tx) in both fast and strict modes. Alice can keep
  dropping orders into the next batch even while the previous batch is
  still clearing.

**Settlement latency** = time from batch close to position credited.

| Mode     | Submit latency | Settlement latency | Total (submit → position) |
| -------- | -------------- | ------------------ | ------------------------- |
| Fast     | ~instant       | ~30s batch + ~5s clearing = ~35s | ~35s |
| Strict   | ~instant       | ~30s batch + ~15-30s FHE clearing = ~45-60s | ~45-60s |

"Early entry" (beating other traders into a batch) is **identical** in both
modes — everyone in the same batch settles at the same uniform clearing
price regardless of submission timestamp within the 30s window. The only
thing strict mode trades away is ~15-30 extra seconds of *waiting for your
fill*, in exchange for relayer-blindness.

**Who picks which tier:**

- Fast: active traders reacting to news; tight short-term positions;
  anyone for whom 30s-vs-60s settlement matters. Privacy is still strong
  (Poseidon commitments + Groth16, no external observer learns your
  order content — only the relayer, whose behavior is bounded by code
  review + open-source operation).
- Strict: whales, institutions, conviction positions, anyone whose threat
  model includes "relayer operator could be coerced or compromised."
  Cryptographically relayer-blind; 30 extra seconds is a rounding error
  relative to the position horizon.

The UI makes this tradeoff explicit per-order (see Todo #21 — `OrderForm`
tier selector with "⚡ Fast (~35s)" vs "🛡️ Strict (~60s, relayer blind)").

---

## 6. End-to-end flows

### 6.1 Onboarding (one-time, 1 signature)

```
Alice logs in with Privy (anonymous SIW, or email if she chooses)
  └─> Privy issues a JWT bound to the login method
        └─> Client derives Ika dWallet seed from JWT (deterministic)
              └─> Ika 2PC-MPC produces public keys for Solana AND Polygon
                    └─> Alice signs once to authorize Ika as delegated signer
```

**After this**: Alice has a main wallet + an Ika dWallet with Solana and Polygon signing capability. She signs once and never sees another popup for routine orders or cross-chain operations.

### 6.2 Per order (first funded order — 1 user-visible signature)

```
Tx A — signed by Alice's main wallet:
  main wallet → Umbra shield on Solana
  [USDC enters the shielded pool; amount obscured by UTXO denomination]

  [Mix window: minimum 60s enforced in UI. The shielded pool
   accumulates other shields/transfers, building anonymity set.]

Tx B — signed by the ephemeral keypair (via Ika), fee-paid by the relayer:
  ephemeral claims from shielded pool
  ephemeral commits FHE-encrypted order + Poseidon commitment H to Solana program
  [The only signer visible on Tx B is the ephemeral. Fee payer is
   the relayer. No link to Alice's main wallet in the transaction graph.]
```

**Signatures visible to Alice**: 1 (Tx A). Tx B is signed by the ephemeral via Ika, invisible to the user.

**Subsequent orders from existing shielded UTXO**: 0 signatures, 0 mix window delay. Balance already mixed.

### 6.3 Per batch — FHE clearing + Polymarket routing (0 signatures)

```
T=0–30s    Orders accumulate, all FHE-encrypted (sealed)

T=30s      Batch closes. FHE clearing runs under encryption:
           ├─ Identifies complementary order pairs (YES + NO at compatible prices)
           ├─ Computes uniform clearing price P for matched pairs
           └─ Marks residuals (unmatched orders)

T=30–45s   Execution via Ika + LPs:
           Path A — Complementary pairs → Polymarket complete-set mint
             ├─ Ika unlocks matched Solana USDC → LP's Solana addr
             ├─ LP releases Polygon USDC → Polymarket CTF.splitPosition($1)
             ├─ YES → buyer's Ika-Polygon addr; NO → seller's Ika-Polygon addr
             └─ Atomic via Ika MPC

           Path B — Residual orders → Polymarket CLOB
             ├─ Ika unlocks user's Solana USDC → LP
             ├─ LP posts limit order on Polymarket CLOB (user's original limit)
             ├─ Polymarket matches against book liquidity
             └─ Fill returned to user's Ika-Polygon addr

T=45–60s   Fill data returned to Solana via cross-chain attestation
           └─ Relayer submits settle_batch with Groth16 proof + fill data
           └─ Positions credited to ephemerals on Solana
```

No user signatures. Relayer is **cryptographically blind** during the 30s sealed window. LPs provide all Polygon capital. Polymarket provides all matching liquidity.

### 6.4 Per claim (0 signatures from Alice)

When a market resolves on Polymarket:

```
Polymarket settles on Polygon: winner receives $1 per share
  └─ Ika-derived Polygon addr (owned by ephemeral) holds the payout

Claim flow on Solana:
Tx C — signed by the ephemeral (via Ika), fee-paid by the relayer:
  ephemeral calls claim_with_proof on Solana program
  ├─ Ika atomically swaps Polygon USDC payout → Solana USDC via LP
  └─ Payout lands in a shielded UTXO owned by the ephemeral
     [Both the recipient AND the amount are hidden in the shielded pool]
```

Alice sees 0 signatures. Positions can sit in the shielded pool indefinitely.

### 6.5 Per unwrap (optional, 0 or 1 signature — user choice)

```
Tx D — signed by the ephemeral (via Ika), fee-paid by the relayer:
  ephemeral's shielded UTXO → Umbra internal transfer → destination's shielded UTXO
  [Signer is the ephemeral (it owns the UTXO). Alice's main wallet not involved.]

Tx E — signed by the destination's key:
  destination's shielded UTXO → public unshield → destination address
  [If destination is a fresh wallet: fresh wallet signs, Alice's main wallet never appears.
   If destination is Alice's own main wallet: Alice signs, her unshield is visible.]
```

**Destination can be any Solana address:**

| Destination               | Privacy effect                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Fresh wallet** (default) | Best — no link between Alice's deposit and this withdrawal                     |
| Exchange deposit address   | Good — off-ramp directly without touching her main wallet again                |
| Friend's wallet            | Effectively a private payment                                                  |
| Her original main wallet   | Weakest — "Alice deposited X" + "Alice withdrew Y" allows P&L inference        |

The UI defaults unwrap destination to **"New wallet"** with original main wallet as opt-in.

**Total Alice-visible signatures per trade lifecycle**: 1 (first-time shield) + 0–1 (optional unwrap) = **1 or 2**. Subsequent orders from the same shielded balance require 0 signatures.

---

## 7. Why the atomic bundle was wrong (and what we changed)

An earlier draft proposed bundling Alice's shield + ephemeral commit into a single atomic tx. That breaks unlinkability: every Solana tx has a single fee payer (a public signer), and if Alice is that fee payer AND the tx contains `commit_order` for ephemeral `7xK9`, observers see "Alice's wallet signed a tx that committed order via 7xK9."

**Fix**: two separate transactions (Tx A and Tx B in §6.2), with the relayer as fee payer for Tx B. Railgun avoided this pitfall the same way — separate txs signed by separate keys, with time in between for mixing.

---

## 8. Fee sponsorship — why the relayer pays ephemeral's fees

Ephemeral keypairs have no SOL. They need SOL for Solana transaction fees.

Three options:

1. **Alice funds it directly** — breaks privacy (Alice's wallet → ephemeral in tx graph).
2. **Umbra shields SOL too** — possible, but Umbra's UTXO model is USDC-focused; adds complexity.
3. **Relayer pays the fee** ← **we use this.**

Relayer sponsorship keeps Alice's main wallet completely absent from Tx B. Rate-limited per ephemeral; refuses sponsorship for ephemerals that haven't been funded via valid Umbra shields.

---

## 9. Mix window — why we enforce a delay

Umbra's anonymity depends on pool activity. If Alice shields at T=0 and commits at T=3s, the pool has only Alice's deposit during that window.

**UI enforcement**: minimum 60s between Tx A (shield) and Tx B (commit). During this window other users' shields/transfers accumulate in the pool. UI shows a "building anonymity set…" countdown. Power users can opt into longer windows (5m, 1h, 1d).

---

## 10. On-chain visibility audit — what observers actually see

For a single Alice trade end-to-end:

**Solana chain:**

| Tx    | Signer                | Visible content                                | Linkable to Alice? |
| ----- | --------------------- | ---------------------------------------------- | ------------------ |
| A     | Alice's main wallet   | "Alice shielded into Umbra"                    | Yes (expected)     |
| B     | Ephemeral             | "7xK9 committed FHE-encrypted order"           | **No**             |
| Settle| Relayer               | "Batch N settled; positions credited"          | **No**             |
| C     | Ephemeral             | "7xK9 claimed payout into shielded UTXO"       | **No**             |
| D     | Ephemeral (via Ika)   | "Umbra internal transfer happened"             | **No**             |
| E     | Destination wallet    | "Destination unshielded X USDC"                | Only if Alice chose her main wallet as destination |

**Polygon chain (visible to Polymarket watchers):**

| Event                  | Visible content                                      | Linkable to Alice? |
| ---------------------- | ---------------------------------------------------- | ------------------ |
| Complete-set mint      | "Ika-Polygon-addr minted $1 complete set"            | **No** — Ika-Polygon addr is unlinked from Alice |
| CLOB order             | "Ika-Polygon-addr posted YES@$0.58 size 100"         | **No** — ephemeral-owned addr |
| Resolution payout      | "Ika-Polygon-addr received $X on resolution"         | **No** — same addr |

The on-chain trail against **Alice's main wallet** is just: *Alice deposited to Umbra on Solana.* That's it. Nothing on Polygon ever touches her main wallet. If she unwraps to a fresh wallet, her main wallet never appears in the flow again.

---

## 11. Privacy modes

The app ships two user-facing privacy modes:

### Fast mode (default for devnet demo)
- FHE disabled, relayer sees plaintext orders during 30s batch window
- 5s clearing + routing
- Total time-to-fill: ~35s
- Trust model: comparable to CoW Protocol — trusted operator for 30s
- All orders still route to Polymarket (no internal counterparty)
- Used for: live demo, low-stakes trading

### Strict mode (promoted architecture)
- FHE enabled, relayer is cryptographically blind to order contents
- 30–60s clearing + routing (FHE compute)
- Total time-to-fill: ~60–90s
- Trust model: no party sees your orders in real-time
- Used for: high-stakes trading, privacy-conscious users

Mode is per-batch (UI toggle) so users can choose based on event sensitivity. All other privacy layers (Umbra, ephemeral, Ika, ZK commitments, Polymarket routing) are active in both modes.

---

## 12. Track alignment (Colosseum)

| Track                  | How Predacy qualifies                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Umbra Privacy**      | Wallet-unlinkability via ephemeral + shielded pool; claims land in shielded UTXOs                                   |
| **Encrypt (FHE)**      | Sealed-bid window + batch clearing price discovery under REFHE; relayer is blind during 30s window                  |
| **IKA (dWallets)**     | 2PC-MPC atomic cross-chain coordination — Solana ↔ Polygon without bridges, orchestrating LP-provided liquidity     |
| **MagicBlock**         | Private Ephemeral Rollup for batch state — optional, strengthens relayer-blind property at state layer              |
| **100xDevs / Adevar / Eitherway** | General Solana app track — novel DeFi primitive (private sealed-bid + cross-chain routing to external CLOB) |
| **RPC Fast**           | Primary RPC provider (X-Token auth, SWQoS priority tx routing) + Yellowstone gRPC streaming for live batch/commit/claim events → replaces frontend polling with SSE push. Devnet supported via Hackathon plan. |

---

## 13. What's mocked today vs. what's real

| Component                    | State                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Solana program               | Deployed to devnet (Program ID `Bb3zRkLip445BQ1S44PC115aws8CCyag4KFkch9ZcKjp`)                  |
| Relayer                      | Running, devnet                                                                                |
| Batch clearing (plaintext)   | Real (uniform clearing price, fast mode, internal devnet only)                                 |
| Poseidon commitments         | Real (circomlibjs)                                                                             |
| Groth16 proofs (off-chain generation) | **Live on devnet** — `USE_REAL_ZK=true`. Relayer runs `snarkjs.groth16.fullProve` on `batch_clearing` + `claim` circuits. Timing (standalone test): batch proof 0.94s, claim proof 0.43s. Real proof bytes submitted to `settle_batch` + `claim_with_proof` instructions. |
| Groth16 proofs (on-chain verification) | **Fully live on devnet, strict `verify()` fatal** (deploy tx `36wCRAAU…`, settle tx `nYeHkA7Q…`, 2026-04-25). `settle_batch` + `claim_with_proof` call `Groth16Verifier::new` + `verify()` — the pairing check is a hard revert now, no more soft-warn. Root cause analysis (3 issues, all fixed): **(1)** proof.b G2 point encoding must be EIP-197 order `(x_c1, x_c0, y_c1, y_c0)` matching what `parse_vk_to_rust.js` produces for the vkey consts. Empirically verified via an on-chain `verify_test_vectors(mode=1)` discriminator that cycled through every ordering — EIP-197 was the only one that passed (tx `41mBPXYNQ8oY…`). **(2)** Before diagnosing (1), we also validated the syscall itself works by running the crate's canonical test vectors on devnet — they verified cleanly (tx `4srrd4fEtsePCVES…`), ruling out any cluster-level issue. **(3)** The `order_count` public input was reading stale on-chain `batch.commitment_count = 0` (relayer doesn't submit `commit_order` on-chain per order — it stores locally), while the prover's public signal had `orderCount = 1`. Fixed by passing `order_count` as a `settle_batch` instruction arg instead of reading it from batch state. This is an acknowledged security softening (a malicious relayer could claim a wrong count), hardened by future work submitting `commit_order` per order. Verifying keys `BATCH_VK` (7 public inputs) / `CLAIM_VK` (9 public inputs) are embedded in `programs/predacy/src/vkeys/` from Light Protocol's `parse_vk_to_rust.js` — regenerate after any circuit change. Relayer negates `proof.a` during formatting (`y → p - y` in BN254 base field) and masks the top 3 bits of the recipient pubkey so the `recipient` public input fits in the BN254 scalar field. |
| Umbra shielding              | **Live on devnet.** Umbra has Solana devnet contracts at `DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ`; devnet indexer at `utxo-indexer.api-devnet.umbraprivacy.com`. Two code paths: (1) Main-wallet path (`getUmbraClient` + `fundEphemeralViaUmbra`) — Privy wallet-standard signs a shield tx, USDC → ephemeral's claimable UTXO. (2) Ephemeral-signer path (Phase B, `getUmbraClientFromEphemeral` + `shieldAndMoveViaMixer`) — ephemeral itself authorizes via `createSignerFromPrivateKeyBytes`, no wallet-standard shim needed. Used by `moveFromEphemeral({ viaMixer: true })` for amount-hiding unlinks (ephemeral ATA → Umbra pool → destination UTXO). Still has a graceful-degrade fallback to plain SPL if indexer is unreachable, but the "Umbra isn't on devnet" line was incorrect — config defaults in `frontend/src/lib/umbra.ts` now point at the right devnet endpoints. |
| Ika dWallet (Pre-Alpha) | **FULLY LIVE on devnet — DKG + Presign + Sign, real signatures end-to-end** (2026-04-24). Example: gRPC signature `91576b06…` matches the on-chain MessageApproval PDA `GG5MrTah…` byte-for-byte (status=Signed, owner=Ika program). Endpoints: `POST /ika/dwallet` (DKG), `POST /ika/transfer-authority`, `POST /ika/presign`, `POST /ika/sign`, `POST /ika/approve-and-sign` (chained). Pre-Alpha caveat: mock signer (not real 2PC-MPC); keypair material is not cryptographically secure until Ika Alpha 1. |
| Ika program CPI integration  | **Live on devnet.** Program deployed with `approve_ika_message` (tx `hGR7XVFM…`). MessageApproval PDAs created via CPI from our program → Ika writes signature back via its network, status transitions Pending → Signed. See `programs/predacy/src/instructions/approve_ika_message.rs`. |
| Ika cross-chain signing      | **Relayer-side ready.** Secp256k1/ECDSA option in `ensureDWallet` produces a Polygon-compat pubkey. Actually using it for Polymarket orders depends on Polymarket routing landing (Todo #13). |
| Ika atomic cross-chain orchestration | **Planning layer + real Ika signatures live on devnet.** `relayer/src/ikaOrchestrator.ts` auto-plans a `CrossChainBundle` for every settled batch (4 legs: unlock-solana, lp-fund-polygon, polymarket-exec, distribute). New `POST /batch/:id/cross-chain/execute` fires REAL Ika `approveAndSign` for each signable leg — three signatures per bundle (user-ephemeral, lp-ika, protocol), each landing a `MessageApproval` PDA on-chain just like the Todo #10 milestone signature. Polymarket leg is no-sig (they move once funded). Bundle state machine: `planned → signing → executed` (all sigs landed) or `reverted` (any leg failed, LP capital rollback intent documented). Unit-tested (24/24) including `executeBundle` happy path + failure rollback. Unexposed at mainnet: actual Polygon-side tx submission (blocked on Polymarket's hosted CLOB being mainnet-only — would need to deploy a CTF Exchange on Polygon Amoy testnet, ~a day of separate work). Cryptographic authorization path is production-ready; the "who actually pushes bytes to Polygon" is the only missing piece. |
| Polymarket CLOB routing      | **Classification + mock routing live; real Polygon submission pending.** Relayer's `pairMatcher.ts` splits every settled batch into Path A (complete-set matchable pairs) and Path B (residuals needing CLOB). `polymarketRouter.ts` produces a structured routing manifest with per-user fill receipts. Exposed via `GET /settlement-stats` (per-batch or recent list). On devnet the on-chain token movement still happens via the existing `lock_funds` over-mint path — the router's receipts are metadata. Real Polygon submission requires Ika atomic swaps + LP Polygon USDC (Todos #18–19). Unit-tested (16/16) across balanced, imbalanced, sell-absorbed, and sell-only batches. |
| LP market for Polygon USDC   | **Mock LP market live on devnet.** `relayer/src/lpRegistry.ts` implements an in-memory LP registry seeded with 3 demo LPs (Boutique Capital @10bps, Genesis LP @15bps, Swift Liquidity @20bps; $160k aspirational capital). `polymarketRouter.ts` picks the cheapest LP with enough capacity per batch (selection rule: lowest feeBps, tie-break on deeper pool), reserves capital up front, and logs the quote. Each settled batch records `liquidityProvider: {lpId, displayName, usdcAmount, feeUsdc, feeBps}` on its settlement stats. Endpoints: `GET /lps` (list), `POST /lps/register` (add), `POST /lps/:id/active` (toggle). Unit-tested (16/16) across cheapest-wins, capacity-fallback, fee-tie-break, inactive-skip, and reserve/release accounting. No real Polygon USDC moves on devnet — the LP state is bookkeeping that the Ika atomic swap (Todo #19) will hook into for real execution. |
| FHE batch clearing (strict mode) | **Two-layer strict-mode: relayer TS mock + real Encrypt REFHE Anchor program on devnet.** (1) Relayer layer — `relayer/src/fheBackend.ts` + `encryptedClearing.ts` — re-expresses the clearing algorithm as an arithmetic-only homomorphic circuit; `MockFheBackend` (transparent 16-byte ct) runs the whole path today, cross-checks bit-identical against plaintext. 41/41 unit tests, `PRIVACY_MODE=strict` flag proven end-to-end on devnet (batch 12 settled via strict path, claim tx `5cWtbufit…`). (2) **On-chain layer — real Encrypt integration on Solana devnet with the full batch-clearing algorithm.** `programs/predacy-fhe/` is an Anchor program that uses Encrypt's actual Rust crates (`encrypt-anchor`, `encrypt-solana-dsl`, `encrypt-types` from https://github.com/dwallet-labs/encrypt-pre-alpha). Defines `#[encrypt_fn] fn settle_batch_graph(...)` — the complete four-side uniform-price clearing algorithm for 4-order batches, expressed as arithmetic-only homomorphic ops (`==`, `>=`, `<=`, `+`, `*` — all mapped to Encrypt DSL codes, auto-promoted to scalar variants when one operand is a plaintext literal). Takes 13 encrypted inputs (4 orders × {side, limit, amount} + clearing price), returns 4 encrypted filled-volume aggregates (yes_buy, no_buy, yes_sell, no_sell). Approximately ~80 HE ops per batch. Compiled to a 201KB SBF binary via `anchor build`; deployed to Solana devnet at `59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn` (latest redeploy tx `43qDbXVXhi…`, previous fill-check-only version `2ed4f6ygJG…`). CPI target: Encrypt's coprocessor program `4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8`. Encrypt's devnet today is plaintext-simulation by design, but our program runs the real graph through their executor — when Alpha 1 ships real on-chain FHE, the same bytes execute confidentially with zero program change. Scoped to 4 orders (vs. Groth16 path's 8) because 4-order input+output ciphertext accounts (17 total) fit in a standard Solana tx without address lookup tables — scaling to 8 is additive (loop unroll + ALT) not new logic. **Invocation status: full end-to-end FHE batch clearing, byte-correct decrypted output, on Solana devnet.** The production-scale 4-order × 4-side `settle_batch_graph` (13 inputs / 4 outputs / ~70 ops) compiles via Encrypt's `#[encrypt_fn]` macro and is deployed at `59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn`.

**Reproducible end-to-end pipeline** (`relayer/scripts/predacy-fhe-real-cpi-demo.ts`):
1. gRPC `CreateInput` registers 13 real input ciphertexts on Encrypt's devnet (4 orders × {side, limit, amount} + clearing price).
2. On-chain `create_output_ct` CPI pre-creates 4 output ciphertexts via Encrypt opcode 2.
3. `register_batch` opens the FHE settlement record PDA.
4. `settle_fhe_batch` lands GREEN on devnet (latest tx `5MiDrMFzAvW2bkU3y9rxLVe9nzkRCrbbcY24TNYVY7sewq7cWn3gkospZ5oHH61uAAxsknHJuP9VZmqRpQ6uZu5p`); CPI trace at depth 1 → 2 → 3 (predacy-fhe → Encrypt program → event emit).
5. Encrypt's pre-alpha mock executor processes the graph asynchronously via WebSocket subscription, computes the 4 aggregates, commits new digests on-chain.
6. `request_output_decryption` CPI per output (Encrypt opcode 11) — decryptor responds with plaintext.
7. The 4 decrypted aggregates **match the expected clearing math byte-for-byte**:
   - `yes_buy_vol`  = 100,000,000  (o0 YES_BUY @ 0.60 ≥ clearing 0.55, fills 100 USDC)
   - `no_buy_vol`   =  60,000,000  (o2 NO_BUY @ 0.45 + 0.55 = 1.00 ≥ 1M, fills 60 USDC)
   - `yes_sell_qty` =  80,000,000  (o1 YES_SELL @ 0.55 ≤ clearing, fills 80 USDC)
   - `no_sell_qty`  =  40,000,000  (o3 NO_SELL @ 0.40 + 0.55 = 0.95 ≤ 1M, fills 40 USDC)

**Bug discovered + fixed during integration:** Encrypt's mock compute engine (`encrypt-compute/src/mock.rs`) does `binary_op` lookups truncated to `fhe_type.byte_width()`. A multiplication chain like `EUint8 * EUint8 * EUint64` (booleans × amount) causes the EUint64 amount to be truncated to 1 byte (e.g. 100,000,000 → 0). Discovered by bisecting the executor envelope: a `bisect_uint8_eq` probe with chain `is_buy * fill * limit` returned 192 instead of 600,000 (= 600,000 mod 256). Fixed by rewriting per-side mask as `if cond { amount } else { zero }` — uses Encrypt's `Select` op which preserves operand width. With the fix, the full 4-order × 4-side production graph runs end-to-end and decrypts to byte-correct values.

**Pipeline scripts:**
- `relayer/scripts/predacy-fhe-real-cpi-demo.ts` — full 4×4 production graph end-to-end, GREEN tx, 4 byte-correct aggregates
- `relayer/scripts/predacy-fhe-poc-demo.ts` — single-side fill demo (3in/1out)
- `relayer/scripts/predacy-fhe-bisect.ts` — controlled bisect across 5+ probe graphs (3in/2out, 3in/4out, 5in/1out, 7in/1out, 3in/1out/15ops, 13in/1out, 13in/4out, 3in/1out/100ops)
- `relayer/scripts/predacy-fhe-1order-probe.ts` — 1-order × 4-sides probe that surfaced the EUint8 truncation bug
- `relayer/scripts/probe-encrypt-activity.ts` — diagnostic showing Encrypt's executor is alive
- `relayer/scripts/all-processed-graphs.ts` — scans on-chain history for processed graph shapes |
| Fee sponsorship              | **Backend ready.** `POST /sponsor-fee` endpoint live on the relayer — accepts ephemeral-signed txs, verifies fee payer + program, co-signs as fee payer, submits. Rate-limited to 5/min per ephemeral. Frontend helper `feeSponsor.ts` ready. Wired into order flow once Ika lands (Todo #8). |
| Mix window enforcement       | **Done (UI).** 60s countdown enforced between shield (Tx A) and commit (Tx B). Configurable via `NEXT_PUBLIC_MIX_WINDOW_SECONDS` for dev. Esc cancels mid-mix. |
| De-atomized order flow       | **Done (UX).** Explicit state machine: preparing → shielding → mixing → committing → success. Visual phase indicator + countdown matches doc §6.2. On-chain Tx B still pending Ika + fee sponsorship. |
| Claim routing (privacy)      | **Done.** Privacy-mode claims route payouts to the ephemeral pubkey's ATA, not the main wallet — preserves the wallet-unlinkability the ephemeral bought at commit time. UI shows a "held privately in ephemeral X…Y" badge. Non-privacy claims go to main wallet as before. |
| Move to address              | **Done (plain SPL path).** Each claimed privacy-mode position gets an inline "Move to address" form — picker for "Fresh wallet (auto-generate)" vs "Paste address", SPL transfer signed by the ephemeral keypair, fee-sponsored by the relayer (sponsor-fee now allows SPL Token + Associated Token + System programs in addition to Predacy). Fresh-wallet path gives the strongest destination-unlink (no prior activity ties to anyone). Umbra-mixer "via mixer" toggle for amount-hiding is Phase B (next). |
| Payout-into-shielded-UTXO    | **Not yet.** Claimed tokens still land in plain ephemeral ATA (amount visible at that address, but address is unlinked from main wallet). Full UTXO shielding requires a Keypair → wallet-standard adapter for Umbra SDK's Solana signer. Tracked as Phase B of the mixer integration. |
| Anonymous Privy / SIW default | **Done.** Login is wallet-only (SIWS); no email, social, or SMS options. Privy's only identifier is the Solana pubkey. |
| In-memory ephemeral          | **Not yet.** Currently persisted to localStorage. Deferred to Phase 3 (Ika) — ephemeral will be re-derivable from MPC key. |
| Privacy RPC default          | **Documented, user-configurable.** Fallback is `api.devnet.solana.com`. `.env.example` lists recommended providers for mainnet. |
| RPC Fast integration         | **Live on devnet, both HTTP + Yellowstone gRPC** (2026-04-23). Primary RPC via `sol-devnet-rpc.rpcfast.com` with X-Token auth; Yellowstone gRPC via `sol-devnet-yellowstone-grpc.rpcfast.com:443` (separate app / separate key) for sub-100ms program event streaming. SSE fanout to frontend. Frontend `useLiveEvents` hook ready to wire into BatchTimer + CommitmentFeed. |

---

## 14. Remaining work to match this doc

In rough order of leverage-to-effort:

1. **Flip defaults (zero UX cost, ships this week)**
   - Anonymous Privy (SIW) as the default login path
   - In-memory ephemeral keys (no localStorage persistence of secrets)
   - No-log privacy RPC as default endpoint

2. **De-atomize order flow** — separate shield (Tx A) and commit (Tx B) in `frontend/src/components/OrderForm.tsx`

3. **Wire Ika dWallet derivation** from Privy JWT — produce both Solana and Polygon keys from the same MPC seed

4. **Add relayer fee sponsorship** — new endpoint `POST /sponsor-fee` signs as fee payer for ephemeral-authored txs

5. **Enforce mix window** in UI — disable "Submit Order" for 60s after a shield, show countdown

6. **Route claims into shielded UTXOs** — update `claim_with_proof` flow in `umbra.ts` to land payouts in Umbra UTXOs instead of plain ATAs

7. **Add "Move to address"** action per settled position in `PositionsPanel.tsx` — triggers Tx D + Tx E with destination picker (default: fresh wallet)

8. **Turn on real ZK** (`USE_REAL_ZK=true`) and verify Groth16 proofs in `settle_batch`

9. **Polymarket CLOB routing** — relayer posts Ika-signed Polygon txs to Polymarket for residual orders; complete-set mint for matched pairs

10. **LP market for Polygon liquidity** — bootstrap with a single relayer-funded LP, then open to external LPs as a yield product

11. **Ika atomic cross-chain orchestration** — wire Ika MPC flow for Solana-USDC-lock ↔ Polygon-USDC-release ↔ Polymarket-mint atomicity

12. **Wire Encrypt REFHE into batch clearing** — relayer receives FHE ciphertexts, runs clearing under FHE, decrypts only aggregates. Adds strict mode.

13. **Privacy mode toggle** in UI — let users pick fast vs. strict per batch

Each of these is incremental — the current devnet build works; these changes harden the architecture to match what this doc describes.
