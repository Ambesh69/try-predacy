# Predacy

**Sealed-bid prediction markets on Solana.** Predacy serves the markets traditional CLOBs and parimutuels can't both serve — short duration, thin maker side, and one uniform price per batch with no per-order leakage.

> Each batch clears at one uniform price computed under FHE. Buyers know exactly what they pay, winners know exactly what they receive, and nobody — not the relayer, not other traders, not the protocol — can see individual orders until after the batch settles.

## How it works

- **30-second sealed-bid batches.** Orders are encrypted commitments until the batch closes. The clearing price is a single uniform price (Groth16-proven; FHE-cleared in strict mode). No frontrunning, no MEV, no per-order leakage.
- **LMSR-anchored price discovery.** The clearing price IS the LS-LMSR bootstrap pool's marginal probability. Each settled residual walks the curve; the next batch prices off the new state. Real-time discovery without market makers.
- **Three-tier liquidity stack.**
  - *Tier 0* — Creator-funded LMSR. Real on-chain collateral at market creation; max loss bounded to seed.
  - *Tier 1* — Blind LP vault with FHE-encrypted per-LP allocation. LPs earn fees + rebates without exposing position size or strategy.
  - *Tier 2* — Cross-chain CLOB routing via Ika dWallets. Residual flow bridges to Polymarket's deep book with no wrapped assets or bridge contracts.
- **Live-stream agent.** Vision-OCR pipeline tails live poker streams (Triton Poker, Hustler Casino Live), auto-creates per-session EventHandles, seeds player + head-to-head prop markets, and auto-resolves them on-chain when the broadcast declares a winner. Cross-signal aggregator gates settlement on ≥2 independent observations within ±10s.

## Why this design

| | CLOB | Parimutuel | **Predacy** |
|---|---|---|---|
| Needs market makers | ✓ | ✗ | ✗ |
| Dilution at bet-time | ✗ | ✓ (late entrants reduce your share) | ✗ (uniform clearing price) |
| Frontrunning | possible | n/a | ✗ (sealed bids) |
| Short-duration markets (1-30 min) | breaks — MMs can't keep quotes fresh | works but odds aren't guaranteed | works — clearing price locked at batch close |
| Privacy | none — book is public | partial — pool is public | full — per-order amounts/sides FHE-encrypted in strict mode |

## Layout

```
programs/predacy/        Anchor program — orders, batches, claims, redeem, LMSR pool, LP vault
programs/predacy-fhe/    Anchor program — Encrypt REFHE batch-clearing graph
relayer/                 TypeScript orchestrator — order intake, batch settlement, ZK proving,
                         on-chain dispatch, live-stream agent, cross-signal aggregator
frontend/                Next.js app — markets index, event detail, LP page, order panel
circuits/                Groth16 circuits — batch clearing + claim membership proofs
docs/ARCHITECTURE.md     Full system architecture
docs/LIQUIDITY.md        Three-tier liquidity design rationale
```

## Run locally

**Relayer** — `cd relayer && npm run dev`
Required env: `SOLANA_RPC_URL`, `RELAYER_KEYPAIR`, `OPENAI_API_KEY`, `YOUTUBE_API_KEY`

**Frontend** — `cd frontend && npm run dev`
Required env: `NEXT_PUBLIC_RELAYER_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`

**Anchor programs** — `anchor build && anchor deploy --provider.cluster devnet`

## Live deployment

- Frontend: [try-predacy.vercel.app](https://try-predacy.vercel.app)
- Program (predacy): `Bb3zRkLip445BQ1S44PC115aws8CCyag4KFkch9ZcKjp` (Solana devnet)
- Program (predacy-fhe): `59ZxSvmRrzCWo4vFjUrdp8sZDCvW2yGU2MGG5EqesLQn` (Solana devnet)

---

Built for the Colosseum Frontier hackathon. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full design.
