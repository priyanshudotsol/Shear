# SHEAR — Components & User Flow (slide diagram)

Two panels, like the whiteboard: **COMPONENTS** (what lives where) on the left, **USER FLOW** (what the trader does) on the right. Green = on-chain, grey = off-chain.

---

## COMPONENTS  —  where each piece lives

```
        ON-CHAIN                                                ON-CHAIN
┌───────────────────────────┐                      ┌───────────────────────────┐
│        BASE LAYER         │                      │         ER LAYER          │
│     (Solana devnet, L1)   │                      │  (MagicBlock Ephemeral    │
│      = the bank / truth    │                      │   Rollup) ~1ms · gasless  │
│                           │                      │   = the trading floor     │
│  • GlobalConfig (params)  │                      │                           │
│  • USDC VAULT  ───────────┼──── DELEGATION ──────┤  • Market (OI, funding)   │
│    (real custody,         │   Market, Pool,      │  • LiquidityPool (synth)  │
│     NEVER delegated)      │   UserBalance,       │  • UserBalance (collat.)  │
│  • LpPosition (LP shares) │   PositionBook       │  • PositionBook (8 slots) │
│  • Deposit / Withdraw     │   L1 ──► ER           │  • open / close / modify  │
│    collateral             │                      │  • liquidate              │
│  • Deposit / Withdraw     │  ◄── COMMIT /        │  • accrue_funding   ⏱1s   │
│    liquidity              │      UNDELEGATE      │  • crank_liquidate ⏱400ms │
│  • Faucet (test USDC)     │   ER ──► L1 (settle) │  • reads real-time oracle │
│  • Settlement             │                      │                           │
└───────────────────────────┘                      └─────────────┬─────────────┘
                                                                 │ reads 2 feeds
                                                                 ▼
                                                   ┌───────────────────────────┐
                                                   │  MAGICBLOCK REAL-TIME     │
                                                   │  ORACLE (Pyth-Lazer)      │
                                                   │  SOL/USD 200ms ÷ ETH/USD  │
                                                   │  50ms → live ratio R      │
                                                   └───────────────────────────┘

        OFF-CHAIN
┌──────────────────────────────────────────────────────────────────────────────┐
│                          OFF-CHAIN SERVICES (no custody)                       │
│                                                                                │
│  • Session operator  → delegate Market+Pool, schedule the funding crank        │
│  • Pyth Hermes stream → live chart + predicted PnL (browser, ~250ms)           │
│  • Client liquidation keeper → fires the crank the instant a position is unhealthy │
│  • Permissionless liquidators → anyone can call `liquidate` (backstop)         │
│  • Event indexer → Prisma/Postgres: trade log, candles, activity feed          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**One-liner:** real money lives on **L1** (vault, never delegated); all trading lives on the **ER** (fast, gasless); off-chain services only watch and index — they never hold funds.

---

## USER FLOW  —  what the trader does

```
┌─────────────────────────────┐
│       Wallet Connect        │   ── get devnet USDC (faucet.circle.com)
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐   ── deposit_collateral   → real USDC into VAULT (L1)
│    Provision  (ONE popup)   │   ── init_position        → create PositionBook (8 slots)
│   batched: 1 wallet approval│   ── set_session_key      → browser key may sign ER trades
└──────────────┬──────────────┘   ── delegate UserBalance + PositionBook  → L1 ➜ ER
               ▼
┌─────────────────────────────┐   ── Market + Pool already on ER (session operator)
│      Trading Enabled        │   ── accounts now live on the rollup
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐   ── open_position(side, collateral, leverage)
│      Place order on ER      │   ── signed by SESSION KEY → no popup, gasless, instant
└──────────────┬──────────────┘   ── also auto-schedules this trader's liquidation crank
               ▼
┌─────────────────────────────┐   ── reads oracle ratio R, locks margin, bumps OI
│      Fill is an ER write    │   ── records entry ratio; emits PositionOpened
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐   ── funding crank accrues every ~1s
│   Live  (no tx — reads+cron)│   ── liquidation crank sweeps every ~400ms
│                             │   ── client renders live PnL / equity / liq-ratio
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐   ── close_position → settle PnL + funding vs pool
│      Close on ER            │   ── proceeds → UserBalance.free_collateral (on ER)
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐   ── undelegate → commit state to L1 → poll until settled
│   Settle + Withdraw (➜ L1)  │   ── withdraw_collateral → real USDC out of vault → wallet
└─────────────────────────────┘
```

**Read it as:** one wallet popup to set up → then every trade is a gasless session-key write on the ER → cash out by settling back to L1.

---

## Color key for the slide

| Region | On/Off chain | Network |
|---|---|---|
| **BASE LAYER** (vault, config, LP, deposit/withdraw) | on-chain | Solana L1 (devnet) |
| **ER LAYER** (market, pool, positions, trading, cranks) | on-chain | MagicBlock Ephemeral Rollup |
| **DELEGATION / COMMIT** arrows | on-chain | the L1 ↔ ER bridge |
| **Real-time oracle** | on-chain | read by the ER |
| **OFF-CHAIN SERVICES** | off-chain | browser + Node + Postgres |
</content>
