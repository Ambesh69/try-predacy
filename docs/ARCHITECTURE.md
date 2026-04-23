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
| Groth16 proofs               | **Mocked** (`USE_REAL_ZK=false`). Circuits compiled but not wired into settle path yet.        |
| Umbra shielding              | **Client wired**, gracefully degrades if SDK can't bridge with Privy wallet-standard           |
| Ika dWallet                  | **Not yet integrated.** Current flow still uses Alice's main wallet as signer.                 |
| Ika cross-chain signing      | **Not yet integrated.** Polygon signing capability is pending.                                 |
| Polymarket CLOB routing      | **Not yet integrated.** Devnet uses internal matching as a stopgap.                            |
| LP market for Polygon USDC   | **Not yet built.** Single relayer-funded LP mock for devnet demo.                              |
| FHE batch clearing           | **Not yet integrated.** Strict mode defined in spec; Encrypt SDK wiring is pending.            |
| Fee sponsorship              | **Backend ready.** `POST /sponsor-fee` endpoint live on the relayer — accepts ephemeral-signed txs, verifies fee payer + program, co-signs as fee payer, submits. Rate-limited to 5/min per ephemeral. Frontend helper `feeSponsor.ts` ready. Wired into order flow once Ika lands (Todo #8). |
| Mix window enforcement       | **Done (UI).** 60s countdown enforced between shield (Tx A) and commit (Tx B). Configurable via `NEXT_PUBLIC_MIX_WINDOW_SECONDS` for dev. Esc cancels mid-mix. |
| De-atomized order flow       | **Done (UX).** Explicit state machine: preparing → shielding → mixing → committing → success. Visual phase indicator + countdown matches doc §6.2. On-chain Tx B still pending Ika + fee sponsorship. |
| Unwrap destination picker    | **Not yet in UI.** Claimed tokens still go to plain ATAs today, not shielded UTXOs.            |
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
