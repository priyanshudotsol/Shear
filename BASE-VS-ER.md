# SHEAR — Each Account on Base Layer vs ER (video script)

Two places exist:
- **Base Layer = Solana (L1)** — the slow, safe layer. Real money lives here.
- **ER = MagicBlock Ephemeral Rollup** — the fast, gasless layer. Trading happens here.

Some accounts live on **both** (they get copied to the ER to trade, then settled back). Some only ever live on the Base Layer. Here's what each one does in each place — read it out loud as you point.

---

## GlobalConfig — the settings
- **On Base Layer:** holds all the rules — fees, max leverage, liquidation settings, and the pause switch. Set once by the admin.
- **On ER:** not there. The ER never needs it, because its numbers get copied into each Market when the market is created.

> *Say:* "GlobalConfig is the rulebook. It stays on Solana — the rollup doesn't even need it, we copy the settings into the market."

---

## USDC Vault — the safe
- **On Base Layer:** holds **all the real USDC**. The only way money moves is deposit (in) and withdraw (out). Guarded by a program key.
- **On ER:** never there. On purpose. The fast layer can't touch real money.

> *Say:* "The vault is the safe with the real money. It only ever lives on Solana — the rollup can never reach it. That's what keeps funds safe."

---

## Market — one trading pair (SOL-ETH)
- **On Base Layer:** created here. Holds the pair's rules and a snapshot of its state. Sits idle while a session is live, and receives the final state when the session ends.
- **On ER:** this is where it comes alive. Every trade and the funding meter update it live — how much is long, how much is short, and the cumulative funding. Updated every block, for free.

> *Say:* "The market is born on Solana, but it does its real work on the rollup — tracking long vs short and funding, updating every millisecond."

---

## LiquidityPool — the money pile traders bet against
- **On Base Layer:** liquidity providers add or remove USDC here (real money in/out of the vault), and shares are issued.
- **On ER:** it's the counterparty to every trade. Trader profits are paid out of it, losses and fees go into it. All these numbers are just bookkeeping — the real cash is in the vault.

> *Say:* "The pool is the house. On Solana people fund it; on the rollup every trade plays against it — win, you take from the pile, lose, you pay into it."

---

## LpPosition — the liquidity provider's receipt
- **On Base Layer:** your share receipt — how much of the pool you own. Lives here because adding/removing liquidity moves real USDC.
- **On ER:** not there. It doesn't need to be — trading doesn't change who owns the pool, only the pool's size.

> *Say:* "LpPosition is just your receipt for funding the pool. It stays on Solana because it's about real money going in and out."

---

## UserBalance — your spending money in the app
- **On Base Layer:** you deposit USDC into it, withdraw out of it, and register your session key here (the one wallet popup).
- **On ER:** while you trade, this holds your free money. Opening a trade locks some of it; closing returns it plus or minus your result. All gasless.

> *Say:* "UserBalance is your in-app wallet. You fill it on Solana, then trade against it on the rollup with no popups and no fees."

---

## PositionBook — your open trades (8 slots)
- **On Base Layer:** created once here (empty, 8 free slots). Then it sits, because trading happens on the rollup.
- **On ER:** this is where all the action is. Open, close, add or remove margin, get liquidated — every one of those changes a slot here, instantly and for free.

> *Say:* "Your position book is set up on Solana, but every actual trade happens on the rollup — open, close, liquidate — all instant, all gasless."

---

## The pattern in one line

> "Real money and the rulebook stay on **Solana**. The market, the pool, your balance, and your trades get **copied to the rollup** to trade fast and free — then settle back to Solana when you cash out."

### Cheat-sheet table

| Account | Base Layer (Solana) | ER (rollup) |
|---|---|---|
| **GlobalConfig** | holds all rules | not there |
| **USDC Vault** | holds real money (deposit/withdraw) | never there (kept safe) |
| **Market** | created; final state settles here | live trading + funding update it |
| **LiquidityPool** | LPs add/remove real USDC | traders win/lose against it |
| **LpPosition** | your pool-ownership receipt | not there |
| **UserBalance** | deposit / withdraw / set session key | holds free money while trading |
| **PositionBook** | created empty (8 slots) | open / close / liquidate happen here |
</content>
