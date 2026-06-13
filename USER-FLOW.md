# SHEAR — End-to-End User Flow (cold start → first LP → first trade)

How the product actually works on Solana + MagicBlock, from a completely empty state to a user
opening and closing a real position. This is the operational source of truth — read it alongside
`lifecycle.md` (design) and `magicblock-integration.md` (verified APIs).

Deployed devnet program: `6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi`

---

## 0. The mental model (read this first)

Two layers, one vault of real money.

| | **Base layer (L1, devnet)** | **Ephemeral Rollup (ER, `devnet.magicblock.app`)** |
|---|---|---|
| Role | custody + account creation + settlement | fast, cheap trading |
| Holds | the **vault** (real USDC), `GlobalConfig`, all accounts when undelegated | `Market`, `Pool`, and each trader's `UserBalance` + `Position` *while delegated* |
| Who signs | the user's **wallet** (Phantom) | a **session key** (local keypair) — NOT the wallet |

Three invariants that explain every step below:

1. **The vault is never delegated.** All real USDC lives in one L1 token account (`vault`, authority
   `vault_auth` PDA). Deposits/withdrawals are always L1 token transfers. So a winner can *always*
   withdraw real tokens, regardless of ER session state.
2. **You can only mutate an account on the layer that owns it.** `deposit_collateral`,
   `deposit_liquidity`, `init_position`, `withdraw_*` are **L1-only** (they touch the vault and/or
   create accounts). `open_position`, `close_position`, `accrue_funding`, `liquidate` are **ER-only**
   (they mutate the delegated `Market`/`Pool`/`UserBalance`/`Position`).
3. **An account is either on L1 or on the ER, never both.** `delegate_*` moves an account L1→ER;
   `undelegate_*` (commit) moves it ER→L1. While `Market`+`Pool` are delegated (a live trading
   session), L1 LP deposits are paused — and vice-versa.

```
        deposit / withdraw (real USDC)              open / close / funding / liquidate
   wallet ──────────────► [ L1 vault + accounts ] ──delegate──► [ ER: Market/Pool/User/Position ]
                                   ▲                                         │
                                   └──────────────── undelegate (commit) ────┘
                                          session key signs everything here ──┘
```

---

## 1. Cold start — the product is empty (admin bootstrap, one time)

State: no config, no market, no pool, no liquidity, no users. The admin runs this once.

| # | Action | Layer | Instruction | Result |
|---|---|---|---|---|
| 1 | Create the USDC mint + vault, init global config | L1 | `initialize_config` | one mint, one vault (authority = `vault_auth` PDA), fee/risk params |
| 2 | Create the `SOL-ETH` market + its pool | L1 | `create_market` | binds the SOL/USD + ETH/USD oracle feeds; pool starts at 0 |
| 3 | Seed first liquidity (e.g. 100k USDC) | L1 | `deposit_liquidity` | **real** token transfer into the vault; `pool_usdc = 100k`, LP shares minted |
| 4 | Hand mint authority to the `vault_auth` PDA | L1 | `setAuthority` (SPL) | enables the on-chain **faucet** so any wallet can get test USDC |
| 5 | *(when ready to trade)* delegate `Market` + `Pool` to the ER, schedule the funding crank | L1→ER | `delegate_market`, `delegate_pool`, `schedule_funding_crank` | **session live** — trading enabled, L1 LP paused |

Scripts: `scripts/setup.ts` (steps 1–4, leaves market on L1 so LP works), `scripts/session-start.ts`
(step 5), `scripts/session-end.ts` (reverse step 5 → `undelegate_shared`, reopens LP).

> The pool is **config-only counterparty capital**. There is no order book and no maker — every trade
> fills against the shared pool at the oracle ratio.

---

## 2. The first liquidity provider

LP is an L1 activity (it moves real USDC in/out of the vault) and requires the pool to be **on L1**
(i.e. no live session, or the admin runs `session-end` first).

1. **Connect wallet.** Phantom on devnet.
2. **Get test USDC.** Click *Get test USDC* → `faucet` mints the program's real SPL USDC to the
   wallet's ATA (capped per wallet). Real, transferable tokens.
3. **Deposit liquidity.** `deposit_liquidity(amount)` → real token transfer wallet→vault; LP shares
   minted pro-rata to pool NAV. The wallet signs (L1 tx, clean simulation, no ER involved).
4. **Withdraw later.** `withdraw_liquidity(shares)` → vault→wallet, gated by pool solvency
   (can't withdraw below open interest). Wallet signs.

NAV/share rises as the pool collects fees and traders' net losses; falls when traders net-win. LP
deposit/withdraw are the **only** flows that change total system USDC — trading conserves it.

---

## 3. The first trader (the full ER round-trip)

This is the path that was breaking. It has a one-time **setup** (L1, wallet signs) and a repeatable
**trade loop** (ER, session key signs). Prerequisite: a **session is live** (admin ran
`session-start`, so `Market`+`Pool` are on the ER).

### 3a. One-time account setup (L1 — the WALLET signs)

| # | Action | Instruction | Notes |
|---|---|---|---|
| 1 | Get test USDC (if needed) | `faucet` | mints the program USDC to the wallet ATA |
| 2 | Deposit collateral | `deposit_collateral(amount)` | real token transfer wallet→vault; creates `UserBalance` (free collateral) |
| 3 | Create the position slot | `init_position` | creates the persistent `Position` PDA for (wallet, market). Works even mid-session (market passed as pubkey only) |
| 4 | **Authorize a session key** | session-keys program `create_session` → `SessionTokenV2` | **the fix** — see §4. One wallet signature; lets a local key trade for you |
| 5 | Delegate trader accounts to the ER | `delegate_user_balance`, `delegate_position` | `UserBalance` + `Position` move L1→ER, onto the same validator as Market/Pool |

After this the trader's accounts live on the ER, funded with collateral, and a session key is
authorized to act for them.

### 3b. The trade loop (ER — the SESSION KEY signs, no wallet popups)

| Action | Instruction | Layer |
|---|---|---|
| Open long/short `SOL-ETH` `Nx` | `open_position(side, collateral, leverage)` | ER |
| Adjust margin | `add_collateral` / `remove_collateral` | ER |
| Funding accrues automatically | `accrue_funding` (crank) | ER |
| Close | `close_position` | ER (settles uPnL+funding into free collateral) |

PnL is path-independent: `uPnL = side · notional · (R_now/R_entry − 1)`, `R = price(SOL)/price(ETH)`.
Every ER tx: blockhash from the **ER** connection, signed by the **session key**, sent
`skipPreflight: true` to `devnet.magicblock.app`.

### 3c. Cash out (ER → L1 — the WALLET signs the withdraw)

| # | Action | Instruction | Layer |
|---|---|---|---|
| 1 | Settle accounts back to L1 | `undelegate_trader` (commit_and_undelegate) | ER→L1 |
| 2 | Wait for L1 settlement | poll until `UserBalance` is program-owned again | — |
| 3 | Withdraw real USDC | `withdraw_collateral(amount)` | L1 (vault→wallet) |

The trader keeps trading on the ER as long as they like; settling is only needed to pull collateral
out to the wallet.

---

## 4. THE INTEGRATION FIX — session keys (why the browser flow was failing)

**Root problem:** our frontend signs **ER transactions with the browser wallet (Phantom)**. That is
*not* how MagicBlock dapps work. Verified against the canonical examples:

- **`roll-dice/app`** — generates a `Keypair` in `localStorage` and signs **every** ER tx with it
  (`tx.sign(keypair)` → `ephemeralConnection.sendRawTransaction(..., {skipPreflight:true})`). The
  browser wallet never signs ER txs.
- **`session-keys/app`** — derives a **temp keypair** `Keypair.fromSeed(sha256(walletPubkey+nonce))`,
  creates a **`session_token_v2`** via the session-keys program (one wallet signature), funds the
  temp key with a little SOL, then signs all ER ops with the temp key. Wallet signs only base-layer
  txs + the one-time session-token creation.

Why wallet-signed ER txs fail in the browser:
1. Phantom **simulates** every tx against its configured devnet RPC. An ER tx carries an **ER
   blockhash** that devnet doesn't know → "transaction may fail / unable to simulate" → the user
   gets scary warnings, and some wallets **block** the signature outright. Hence the hangs.
2. Even when it works, it's a wallet popup **per trade** — not the gasless UX MagicBlock is for.

**Our program already supports the fix.** `programs/shear/src/instructions/trade.rs::authorize()`
accepts either the owner *or* a `SessionTokenV2` (seed `session_token_v2`, session-keys `3.1.1`), and
`UserBalance.session_authority` exists for it. We just never wired the client side.

### What the correct frontend does

```
On "Enable trading" (one wallet signature):
  1. tempKey = Keypair.fromSeed(sha256(wallet.pubkey + nonce))      // deterministic, in localStorage
  2. wallet signs create_session  → SessionTokenV2 { authority: wallet, session_signer: tempKey }
  3. transfer ~0.02 SOL from wallet → tempKey                       // ER tx fees
Thereafter, EVERY ER tx (open/close/add/remove/undelegate):
  - built against the ER connection, accounts include the session_token
  - signed by tempKey  (NO Phantom popup, no simulation warning)
  - sent skipPreflight to devnet.magicblock.app
Base-layer txs (faucet / deposit / withdraw / delegate) still signed by the wallet.
```

This removes the per-trade popups, eliminates the ER-simulation warnings, and is the path
MagicBlock intends for browser dapps. **Until this is wired, ER trades depend on Phantom approving
an unsimulatable tx — fragile and the source of the failures.**

### Secondary robustness (from `roll-dice` / `anchor-counter`)

- Resolve the validator via the **router** (`devnet-router.magicblock.app`) +
  `getClosestValidator()` / `getDelegationStatus()` and **pin that validator** in every `delegate_*`
  (pass its identity in `remainingAccounts`) so all four accounts co-locate. We currently hardcode
  `devnet.magicblock.app` and don't pin — fine on single-validator devnet, but pinning is the robust
  pattern.
- After delegating, poll `getDelegationStatus().isDelegated` (and account presence) before the first
  ER tx — we already added an ER-readiness wait.

---

## 5. State machine (per account)

```
UserBalance / Position:
  (none) --init/deposit--> L1:program-owned --delegate--> ER:delegated --undelegate--> L1:program-owned
                                  ▲                                                          │
                                  └──────────────────────────────────────────────────────────┘

Market / Pool (shared, admin-controlled):
  L1:program-owned  --delegate_market/pool-->  ER (session live)  --undelegate_shared-->  L1 (LP open)
```

A program **redeploy while an account is delegated can corrupt it** (the ER's cloned copy is dropped
→ a 0-length shell on both layers that can't be read, deposited to, re-init'd, or undelegated). This
only happens during dev churn; in production you don't redeploy mid-session. Recovery: use a fresh
wallet (new PDAs). This is exactly what bricked the test wallet `HA3Dhb9…`.

---

## 6. Quick reference — who signs what, on which layer

| Instruction | Layer | Signer | Phase |
|---|---|---|---|
| `initialize_config`, `create_market` | L1 | admin | bootstrap |
| `faucet` | L1 | wallet | get test USDC |
| `deposit_liquidity` / `withdraw_liquidity` | L1 | wallet (LP) | provide liquidity |
| `deposit_collateral` / `withdraw_collateral` | L1 | wallet (trader) | fund / cash out |
| `init_position` | L1 | wallet | one-time |
| `create_session` (session-keys program) | L1 | wallet | one-time, enables session key |
| `delegate_market` / `delegate_pool` / `schedule_funding_crank` | L1→ER | admin | start session |
| `delegate_user_balance` / `delegate_position` | L1→ER | wallet | start trading |
| `open_position` / `close_position` / `add_collateral` / `remove_collateral` | ER | **session key** | trade loop |
| `accrue_funding` | ER | crank (autonomous) | always |
| `liquidate` | ER | anyone (keeper) | risk |
| `undelegate_trader` | ER→L1 | wallet or session key | cash out |
| `undelegate_shared` | ER→L1 | admin | end session (reopen LP) |
```
