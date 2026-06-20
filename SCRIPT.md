# SHEAR — Presentation Script (read top to bottom)

One continuous script. Just read it. ~2.5 minutes.

---

Hey, I'm Priyanshu, and this is **SHEAR**.

SHEAR is a relative-value perpetuals exchange on Solana. In plain words — instead of betting a coin goes up or down, you bet on **one asset beating another**. Long SOL, short ETH, in a single click, as one position.

Here's why that matters.

Every trader has had this thought: *"SOL is going to outperform ETH."* That's not a bet on the market going up or down — it's a bet on the **ratio** between the two. But today, to make that bet, you have to open two separate trades — long SOL and short ETH — and babysit both. Two positions, two margins, two liquidation prices.

And here's where it breaks. When the market dumps, one of those legs gets liquidated while the other keeps running — and your safe, market-neutral trade quietly flips into a bet **against your own idea**. Pear Protocol raised four million dollars solving this on Arbitrum. On Solana, there's nothing like it. That's the gap SHEAR fills.

SHEAR makes the **ratio itself** the thing you trade. One market, like SOL-ETH. One position. One margin. One liquidation. You go long, and you win when SOL outperforms ETH — **even if the entire market is red**. The part they move together cancels out; only the difference pays you.

Now, the interesting part is **how** it's built, and this is where MagicBlock comes in.

A ratio reprices every millisecond. To trade it you need constant repricing, constant funding, and liquidation checks every block — and you need all of it **free**. On regular Solana, with 400-millisecond blocks and a fee on every action, that's impossible. So we split the system in two.

The **base layer is Solana** — this is the safe. All the real USDC sits in one vault here and it never leaves. The rules, the deposits, the withdrawals all live here. Real money only ever moves on Solana. That's the trust anchor.

The **fast layer is MagicBlock's Ephemeral Rollup** — this is the trading floor. One-millisecond blocks, zero gas. When you trade, we move your accounts into the rollup, you trade at full speed, and when you cash out we settle everything back to Solana and pay you real USDC from the vault.

So the whole idea is simple: **real money on Solana, fast trading on the rollup.**

And MagicBlock gives us four things that make this actually work. **Session keys** — you approve once, then every trade after that is gasless and instant, no wallet popups; it feels like a centralized exchange but it's fully on-chain. A **funding crank** — a job that runs on-chain every second, by itself, no server. A **liquidation crank** — the rollup automatically checks every position a few times a second and closes anything underwater, again with no bot. And a **real-time oracle** — two live price feeds, SOL and ETH, divided on-chain into the live ratio every 50 milliseconds.

Let me show you why all this matters in one picture.

Same idea, two traders. The market is dumping — SOL down 8%, ETH down 12%. So SOL **did** outperform ETH. On the left, the old way: a directional long on SOL — he was right, and he still gets **liquidated** in the crash. On the right, SHEAR: long SOL-ETH — the ratio went up, so this position stays **green through the entire dump**.

Same correct call. Opposite outcome.

That's the whole point of SHEAR — **being right about the matchup should pay you, even when the market is wrong.** It's a category that exists everywhere else in trading, and we finally built it on Solana, made possible by MagicBlock's speed, zero fees, on-chain cranks, and session keys.

I'm Priyanshu, this was SHEAR. Thanks for watching.
</content>
