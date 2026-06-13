# SHEAR — Build Components

Components for the SHEAR build, organized by layer. Cross-references the real example folders in `../magicblock-engine-examples/`.

**Deployment target: Solana devnet + MagicBlock devnet ER.** No mainnet for the hackathon.

## On-chain (program side)

| Component | What for | Source / reference |
|---|---|---|
| Anchor **1.0.2** | Program framework (current MagicBlock ER stack; Path A) | workspace; see `magicblock-integration.md §0` + `build-guide.md` |
| `ephemeral-rollups-sdk` (`--features anchor`) | `#[ephemeral]`, `#[delegate]`, `#[commit]`, `delegate_pda`, commit/undelegate | docs.magicblock.gg; pattern in `../magicblock-engine-examples/anchor-counter` |
| `delegation-program` CPI | Delegate `Market`, `UserBalance`, `Position` PDAs to the ER | `anchor-counter` (delegate/commit flow) |
| MagicBlock crank / `ScheduleTask` | Drives `accrue_funding` + `crank_liquidations` every N ms, no external keeper | `../magicblock-engine-examples/crank-counter` |
| `pyth-solana-receiver-sdk` | Deserialize `PriceUpdateV2` for both feeds | `oracle.md` |
| SPL Token (USDC mock) | Collateral + LP pool custody | `../magicblock-engine-examples/spl-tokens`, `dummy-token-transfer` |
| Solana base RPC | Market/pool init, collateral & LP deposit/withdraw, settlement | `https://api.devnet.solana.com` |
| MagicBlock ER endpoint | `open/close/liquidate`, funding accrual | `https://devnet.magicblock.app/` |
| Magic Router | Auto-routes txs to ER (delegated accts) vs base | `https://devnet-router.magicblock.app` |

The same Anchor program runs on **both** base layer and the ER unchanged; only the delegation status of the accounts differs. The router dispatches automatically based on which accounts a tx writes.

## Price oracle

| Option | Use when |
|---|---|
| **MagicBlock Real-Time Pricing Oracle** (primary) | Live on devnet ER, Pyth-Lazer-fed, ~50–200ms push. We read **two** feeds (SOL/USD + ETH/USD) and divide on-chain into the ratio. Used on every `open/close/liquidate` and for funding. |
| Standard Pyth pull (`pyth-solana-receiver`) | Fallback / base-layer reads if the ER oracle misses a feed |

SHEAR is a **read-only** oracle consumer — we never push prices, never run a pusher, never init/delegate feeds. Full wiring + feed accounts in `oracle.md`. Reference repo: `magicblock-labs/real-time-pricing-oracle`.

## Crank / automation (the funding + liquidation engine)

**Crank-driven, not event-driven.** Two scheduled tasks via `ScheduleTask`:

1. `accrue_funding(market)` — every `FUNDING_TICK` (e.g. 1s): recompute skew, advance `Market.cum_funding`. Cheap, one account write.
2. `crank_liquidations(market)` — every `LIQ_TICK` (e.g. 100ms–1s): scan a bounded set of open positions, liquidate any with `equity < MMR*N`.

This is the part L1 can't afford — per-second funding + sub-second liquidation sweeps are free inside the ER. Pattern: `../magicblock-engine-examples/crank-counter` (`ScheduleTask`, `execution_interval_millis`, `iterations`). Permissionless `liquidate` remains as a backstop so the demo never depends solely on the crank.

## Session / wallet

| Component | What for |
|---|---|
| **Session keys** (gpl-session) | One-click, gasless `open/close` without a wallet popup per trade — the CEX-feel | `../magicblock-engine-examples/session-keys` |
| **Privy embedded wallet** | Frictionless onboarding for the demo (no seed phrase) | optional |
| `@magicblock-labs/ephemeral-rollups-sdk` (TS) | `ConnectionMagicRouter`, dual-connection routing | docs.magicblock.gg |
| `@coral-xyz/anchor` + `@solana/web3.js` | Program client + base RPC | — |

## Frontend

| Component | Notes |
|---|---|
| Next.js 14 (app router) | Vercel-friendly |
| TailwindCSS + shadcn/ui | Fast scaffolding |
| `lightweight-charts` | **The ratio chart** — live SOL/ETH ratio re-ticking every ER block (the hero visual) |
| WebSocket → ER endpoint | `accountSubscribe` on `Market`/`Position` + the two oracle feeds; recompute ratio, equity, liq-ratio client-side between events |
| Framer Motion | "long one ⚔ short the other" open animation; PnL counter |

Three core screens: **Trade** (ratio chart + one-click long/short + leverage slider), **Position** (live equity, margin ratio, liquidation ratio, funding accrued), **Pool** (LP deposit/withdraw, NAV/share, utilization). Plus the **Demo** screen (§ below).

## Settlement collateral

Devnet USDC mock (mint your own) held in the program-owned `ShearVault` token account. Synthetic `free_collateral` bookkeeping inside `UserBalance` for ER trading; real token transfers only at `deposit_collateral` / `withdraw_collateral` on base. For the demo, fake collateral is fine — judges won't fund real positions.

## Indexing / log streaming

- ER/base RPC `logsSubscribe` on the program → capture `PositionOpened/Closed`, `Liquidated`, `FundingAccrued` for the live feed + PnL ticker.
- No Helius / external indexer needed for hackathon scope.

## Demo infrastructure (the market-neutral split-screen)

To make the "right thesis, opposite outcome" comparison land:
- A **scripted price track** for the clip: SOL −8%, ETH −12% over ~20s (drive a local mock feed, or overlay on the live oracle for the recording).
- **Left panel — directional long SOL 5x**: a thin simulated perp (oracle-mark PnL, no SHEAR logic) that goes deep red and liquidates.
- **Right panel — SHEAR long `SOL-ETH` 5x**: the real program; ratio rises, position stays green.
- Synced PnL counters + the live ratio/funding/crank-heartbeat ticker. Pure client-side dramatization for the left side; the right side is the real on-chain program.

## Hosting

| What | Where |
|---|---|
| Frontend | Vercel |
| Demo video / assets | Vercel static |
| Production domain (final) | `shear.market` / `shear.exchange` once purchased (see `naming.md`) |

## Optional but worth considering

- **`ephemeral-vrf`** (`../magicblock-engine-examples/rewards-delegated-vrf`, `roll-dice`) — only if we add randomized liquidator selection or fair tie-breaks. Not core; skip for v0.
- **TEE / private positions** (`../magicblock-engine-examples/private-counter`, `private-payments`, `pinocchio-private-counter`) — hide position size / liquidation level so it can't be hunted. Strong v1 story (and plays to prior TEE experience); out of scope for the weekend.
- **`magic-actions`** (`../magicblock-engine-examples/magic-actions`) — base-layer auto-execution while delegated; possible for auto-settling funding to base.

## What you don't need

- Custom matching engine / order book (execution is oracle-ratio against the pool, no impact).
- A real second perp venue (single synthetic ratio instrument — `MATH.md` §8).
- External keeper bot (the crank is on-chain; permissionless `liquidate` is the backstop).
- Backend API server (everything is on-chain or in the browser).
- Authentication (wallet IS auth; session keys for gasless).
- vAMM / virtual reserves (oracle-priced pool, no peg to maintain).
