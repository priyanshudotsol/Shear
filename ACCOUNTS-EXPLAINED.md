# SHEAR — Every Account in Simple Words

What each piece stores, in plain language.

| Account | What it is, simply |
|---|---|
| **GlobalConfig** | The settings. Fees, limits, on/off switch. |
| **USDC Vault** | The safe. Holds all the real money. |
| **Market** | One pair, like SOL-ETH. Tracks who's long and short. |
| **LiquidityPool** | The money pile traders bet against. |
| **LpPosition** | A receipt showing how much of the pile you own. |
| **UserBalance** | Your spending money inside the app. |
| **PositionBook** | Your open trades (room for 8). |

---

## GlobalConfig — the settings
The rulebook for the whole app. It holds the fee amount, the max leverage, the liquidation rules, and a button to pause everything. Set once by the admin. Nobody trades against it — it just holds the numbers everyone follows.

**Lives on:** Solana (L1).

---

## USDC Vault — the safe
One box that holds **all the real USDC** — both trader money and liquidity money, together. Real money only goes in (deposit) or out (withdraw). The fast trading part can never touch it. This is what keeps funds safe.

**Lives on:** Solana (L1). Never moves to the rollup.

---

## Market — one trading pair
One market = one pair, like **SOL-ETH**. It stores the rules for that pair and the live numbers: how much money is long, how much is short, and the funding meter. This is the thing that gets traded on the fast rollup.

**Lives on:** Solana, then copied to the rollup for fast trading.

---

## LiquidityPool — the money pile
When you trade, you're not trading against another person. You trade against this shared pile of USDC. If you win, you get paid from the pile. If you lose, your money goes into the pile. It also keeps a small backup fund for bad days.

**Lives on:** Solana, then copied to the rollup.

---

## LpPosition — your share receipt
If you add money to the pile (become a liquidity provider), you get **shares**. This account is your receipt. The more the pile earns from fees, the more your shares are worth when you take your money out.

**Lives on:** Solana (L1).

---

## UserBalance — your spending money
Your free money inside the app — the part not locked in a trade yet. You deposit to fill it, open a trade to lock some of it, close a trade to get it back, and withdraw to send it to your wallet. It also remembers your **session key** — the helper key that lets your browser place trades without asking your wallet every time.

**Lives on:** Solana, then copied to the rollup while you trade.

---

## PositionBook — your open trades
Holds up to **8 trades** at once. Each trade is separate — it has its own side (long or short), size, entry price, and locked money. One trade going bad can't hurt the others. Made once, then reused every time you open or close.

Each trade slot remembers:
- long or short
- how big it is
- the price you entered at
- the money locked in it
- whether it's open, closed, or got liquidated

**Lives on:** Solana, then copied to the rollup while you trade.

---

## How it all fits

1. **GlobalConfig** holds the rules.
2. The **Vault** holds the real money. **UserBalance** and **LiquidityPool** are just scorecards tracking who owns what.
3. You spend from your **UserBalance** to open trades in your **PositionBook**.
4. Those trades bet against the **LiquidityPool**.
5. **LpPosition** is the receipt for people who funded that pool.

Real money stays safe on Solana. The trading happens fast on the rollup. That's the whole idea.
</content>
