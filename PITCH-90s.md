# SHEAR — 90-Second Architecture Pitch

**Use this to explain the architecture to a judge in 1.5 minutes.** Read the script, point at the diagram, stop. Everything below the script is backup for Q&A only.

---

## The one diagram (point at this)

```
        YOU (browser + Phantom)
                │
     1 popup to start, then ZERO popups (session key signs every trade, gasless)
                │
   ┌────────────┴─────────────┐
   ▼                          ▼
 SOLANA L1                MAGICBLOCK ROLLUP
 (the bank)               (the trading floor)
                          ~1ms blocks · no fees
 • Real USDC vault   ──►  • Your position + margin
   (never moves)   delegate • Live ratio = SOL/ETH
 • Deposit/Withdraw  ◄──  • Funding crank  (every 1s)
                  settle   • Liquidation crank (~400ms)
                          • Reads real-time oracle
```

---

## The 90-second script

**(0–20s) The problem.**
"Every trader thinks *'SOL will beat ETH.'* That's a bet on the **ratio**, not the market. Today you'd open two perps — long SOL, short ETH — and babysit both. When the market dumps, one leg gets liquidated and your market-neutral trade flips into a bet *against* your own thesis. Pear Protocol proved people want this — raised 4 million — but **there's nothing like it on Solana.**"

**(20–40s) The product.**
"SHEAR makes the **ratio itself** the instrument. One click: long `SOL-ETH`. One position, one margin, one liquidation. You profit when SOL outperforms ETH — even if the whole market is red. The market they're both in cancels out."

**(40–75s) The architecture — why MagicBlock.**
"A ratio reprices every millisecond, so it needs continuous repricing, continuous funding, and per-block liquidation checks. On Solana L1 — 400ms blocks, a fee every tick — that's impossible. So we split it:

- **Real USDC stays on Solana L1**, in a vault that never moves. That's the security anchor.
- **Trading runs on a MagicBlock Ephemeral Rollup** — 1ms blocks, zero gas. We *delegate* your position into the rollup, trade at full speed, and *settle* back to L1 to withdraw.
- **Two on-chain crons** run with no bot, no server: a **funding crank** every second and a **liquidation crank** every 400ms — MagicBlock's `ScheduleTask` re-fires them forever.
- **Session keys** mean one wallet popup to start, then every trade is gasless and instant — it feels like a CEX."

**(75–90s) The close / demo bridge.**
"So: MagicBlock is what makes a relative-value perp *affordable to run*. Let me show you — same correct call, two traders: the directional one gets liquidated in the dump, SHEAR stays green. **Being right should pay even when the market is wrong.**"

---

## If they ask (one-liners)

- **"Is the money real?"** → Real SPL USDC, custodied in a program-owned vault on L1 that's *never* delegated. Rollup balances are synthetic and reconcile to the vault on commit.
- **"What's the oracle?"** → MagicBlock's real-time Pyth-Lazer oracle. We read two feeds — SOL/USD and ETH/USD — and divide them **on-chain** into the live ratio. 50–200ms fresh.
- **"How do liquidations work without a keeper?"** → Three layers: the native MagicBlock crank (`ScheduleTask`), a client-side watcher, and a permissionless `liquidate` anyone can call. All hit the same on-chain check, which no-ops if the position is actually healthy.
- **"Why is it safer than a normal perp?"** → A ratio only moves as much as the two assets move *relative* to each other. SOL −20% / ETH −18% is a ~2% ratio move, not 20%. Same leverage, far less bad debt.
- **"What's deployed?"** → Devnet. Program `6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi`, `SOL-ETH` market live, both cranks running, session-key trading working end-to-end.
- **"Where's MagicBlock used?"** → Five places: delegation, rollup execution, session keys, commit/undelegate, and the two cranks. Remove any one and the product breaks.

---

## The 3 things to land (if you forget everything else)

1. **Ratio = the instrument** → one position, market-neutral, no leg drift.
2. **L1 holds the money, the rollup does the trading** → real custody + 1ms/gasless speed.
3. **Two on-chain crons + session keys** → continuous funding & liquidation with no bots, CEX-feel UX. **Only possible on MagicBlock.**
</content>
