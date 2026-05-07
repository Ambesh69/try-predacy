# Predacy

**Sealed-bid prediction markets on Solana.** Predacy serves the markets traditional CLOBs and parimutuels can't both serve — short duration, thin maker side, and one uniform price per batch with no per-order leakage.

> Predacy serves the markets CLOBs can't (short duration, thin maker side) without the dilution that parimutuels can't avoid. Each batch clears at one uniform price computed by ZK proof — buyers know exactly what they pay, winners know exactly what they receive.

## How

- **30-second sealed-bid batches.** Orders are encrypted commitments until the batch closes; clearing price is a single uniform price (Groth16-proven). No frontrunning, no MEV, no per-order leakage.
- **LMSR-anchored price discovery.** The batch's clearing price IS the LS-LMSR bootstrap pool's marginal probability. Each settled residual walks the curve; the next batch prices off the new state. Real-time discovery without market makers.
- **Three-tier liquidity stack.** Tier 0 LMSR fills cold-start residuals (bounded loss b·ln 2 ≈ $100/market seed). Tier 1 Blind LP vault (FHE-encrypted per-LP allocation) absorbs once the event graduates. Tier 2 maker rebates fund the per-event credit pool.
- **Live-stream agent.** Vision-OCR pipeline tails live poker streams (Triton, Hustler Casino Live), auto-creates per-session EventHandles, seeds player + H2H prop markets, and auto-resolves them on-chain when the broadcast declares a winner.

## Positioning

| | CLOB | Parimutuel | **Predacy** |
|---|---|---|---|
| Needs market makers | ✓ | ✗ | ✗ |
| Dilution at bet-time | ✗ | ✓ (late entrants reduce your share) | ✗ (uniform clearing price) |
| Frontrunning | possible | n/a | ✗ (sealed bids) |
| Short-duration markets (1-30 min) | breaks down — MMs can't keep quotes fresh | works but odds aren't guaranteed | works — clearing price locked at batch close |
| Privacy | none — book is public | partial — pool is public | full — per-order amounts/sides FHE-encrypted in strict mode |

## Layout

```
programs/predacy/        Anchor program (Rust)
relayer/                 Off-chain orchestrator: order intake, batch clearing, ZK proof generation,
                         on-chain settlement, agent (vision OCR + market lifecycle), settlement engine
frontend/                Next.js — markets index, event detail with featured polymarket-style card,
                         /lp liquidity provisioning, /market detail with sealed-bid order panel
circuits/                Groth16 circuits — batch clearing + claim membership proofs
docs/ARCHITECTURE.md     Full system architecture
docs/LIQUIDITY.md        Tier 0/1/2 design rationale
```

## Run

Relayer (Railway): `cd relayer && npm run dev` — needs `SOLANA_RPC_URL`, `RELAYER_KEYPAIR`, `OPENAI_API_KEY`, `YOUTUBE_API_KEY`.

Frontend (Vercel): `cd frontend && npm run dev` — needs `NEXT_PUBLIC_RELAYER_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`.

Anchor program: `anchor build && anchor deploy`.

---

Built for the Colosseum hackathon. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full design.
