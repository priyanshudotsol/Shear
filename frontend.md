# SHEAR — Frontend Spec

The UI's job: make "trade one asset against another, in real time" obvious in 10 seconds, and make the market-neutral demo undeniable. Keep it thin — the program is the product; the frontend reads ER state + oracle feeds and sends gasless trades.

## Stack

| Piece | Choice | Why |
|---|---|---|
| Framework | Next.js 14 (app router) | Vercel deploy |
| Styling | TailwindCSS + shadcn/ui | fast, clean |
| Chart | `lightweight-charts` | the live ratio chart (hero visual) |
| Chain client | `@solana/web3.js` + `@coral-xyz/anchor` | base + program |
| ER routing | `@magicblock-labs/ephemeral-rollups-sdk` (`ConnectionMagicRouter`) | auto L1/ER dispatch |
| Oracle decode | `@pythnetwork/pyth-solana-receiver` | decode `PriceUpdateV2` client-side |
| Wallet/session | wallet-adapter + session keys (Gum) / optional Privy | gasless one-click |
| Animation | Framer Motion | open/close + PnL counter |

## Data flow

```
WS accountSubscribe → [base_feed, quote_feed, Market, Pool, Position]
   ├─ on feed tick: ratio = base/quote ; recompute live equity, margin ratio, liq ratio, funding
   ├─ on Position change: update position card
   └─ on Pool change: update LP/AUM card
Trade action → build ix → ConnectionMagicRouter → ER (signed by session key, gasless)
```

The frontend recomputes PnL/equity/liq-ratio **locally** on every oracle tick so the UI feels alive between on-chain writes (the chain confirms; the UI predicts).

## Screens

### 1. Trade (the main screen)
- **Ratio chart** (`lightweight-charts`): live `SOL/ETH`, re-ticking on every oracle update. Entry line + liquidation line overlaid when a position is open. This is the hero — "repriced continuously" made visible.
- **Order panel**: market selector (`SOL-ETH`), **Long / Short** toggle (framed "SOL vs ETH"), collateral input, leverage slider (1–10x), live preview of notional, entry ratio, liquidation ratio, fee. One **"Open"** button → gasless.
- **Live readouts**: current ratio, 24h ratio change, funding rate (ticking), pool utilization.

### 2. Position
- Card per open position: side, notional, entry ratio, **live equity** (green/red, animated), margin ratio, **liquidation ratio** (with distance-to-liq bar), accrued funding, fees. **"Close"** button → gasless settle.
- History: closed/liquidated positions with realized PnL.

### 3. Pool (LP)
- AUM, NAV/share, your shares + value, net-OI utilization (`|net_oi| / (pool_usdc·MAX_NET_UTIL)`), insurance fund. Deposit/withdraw (L1, session-boundary — show a clear "settles on base layer" note).

### 4. Demo (the money shot — `concept.md`)
Split screen, scripted SOL −8% / ETH −12%:
- **Left**: simulated directional long-SOL 10x (client-side mock) → bleeds red → **liquidated**.
- **Right**: real SHEAR long `SOL-ETH` 10x → ratio rises → **+~45%** green.
- Synced PnL counters + the live ratio/funding/crank-heartbeat ticker. The left side is pure client-side dramatization; the right side is the real on-chain program.

## UX specifics

- **Session onboarding**: first trade prompts one approval to create a session token (`validUntil = now + 1h`); after that, open/close are popup-free and fee-free. Show a small "gasless session active" badge.
- **Deposit/withdraw** clearly labeled as base-layer (real USDC) vs trading (instant, ER). Don't let users think a withdraw is instant mid-session.
- **Oracle health indicator**: a dot that goes amber if either feed is stale/wide-confidence (trades will reject) — pre-empts confusion during the demo.
- **Numbers**: ratio to 5 sig figs; USDC to 2 decimals; equity updates at oracle cadence (~50–200ms), not faster (honest, not fake 1ms flicker).

## Event feed (optional, nice for demo)

`logsSubscribe` on the program → stream `PositionOpened/Closed`, `Liquidated`, `FundingAccrued` into a live ticker. Sells the "things are happening on-chain, continuously" story.

## What the frontend does NOT do

- No backend/API server — all reads are RPC/WS, all writes are client-signed.
- No custody — wallet + session key only.
- No off-chain matching/pricing — the ratio and PnL come from on-chain oracle + program state.
