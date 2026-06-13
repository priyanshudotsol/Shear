# SHEAR — Lifecycle: L1 ↔ ER, Sessions, Crank

How accounts cross the base-layer ↔ Ephemeral-Rollup boundary, how gasless trading works, and how the crank runs funding + liquidations. Grounded in the MagicBlock examples: `anchor-counter` (delegate/commit), `session-keys`, `crank-counter`, `spl-tokens`.

## The core principle

**Real USDC never leaves L1.** Trading is fast because it mutates *synthetic* balances in delegated PDAs inside the ER; the physical USDC sits in one L1 token account (`ShearVault`). Money only moves on L1, at the boundary (deposit / withdraw). Everything between is bookkeeping that commits back to L1.

```
        L1 (Solana devnet)                         Ephemeral Rollup (MagicBlock)
  ┌───────────────────────────┐             ┌───────────────────────────────────┐
  │ ShearVault (real USDC)    │             │  Market   (OI, cum_funding)        │
  │ GlobalConfig, LpPosition   │  delegate   │  LiquidityPool (pool_usdc, fees)   │
  │ Market*  ─────────────────────────────►  │  UserBalance (free_collateral)     │
  │ LiquidityPool*  ──────────────────────►  │  Position (the trade)              │
  │ UserBalance*, Position*    │  commit /   │  oracle feeds (read-only)          │
  │                            │ ◄─undelegate │  funding + liq crank (every block) │
  └───────────────────────────┘             └───────────────────────────────────┘
        *delegated accounts live logically here, executed there
```

## Delegation mechanics (from `anchor-counter`)

- A delegatable account is a **PDA owned by the SHEAR program**. The program is annotated `#[ephemeral]`; a `#[delegate]` Accounts struct marks the PDA `#[account(mut, del)]`.
- Delegate via `ctx.accounts.delegate_pda(&payer, &[seeds], DelegateConfig { commit_frequency_ms, validator })`. This **transfers the account's owner to the delegation program**; the ER validator now executes against it.
- While delegated, handlers that mutate the account take it as `UncheckedAccount` and **manually deserialize/serialize** (Anchor would re-serialize stale data because ownership changed). Check delegation by `owner == DELEGATION_PROGRAM_ID`.
- **Commit** (push ER state to L1 without giving up the ER): call `acct.exit(&crate::ID)?` **first** (serializes the Anchor account), then `MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit(&[acct.to_account_info()]).build_and_invoke()`. Also automatic every `commit_frequency_ms`. *(Verified verbatim in `anchor-counter`/`dummy-token-transfer`; the `.exit()` step is required.)*
- **Undelegate** (commit + return ownership to SHEAR): `…commit_and_undelegate(&[acct])`, via the `#[commit]` Accounts struct (adds `magic_context`, `magic_program`). The `MagicIntentBundleBuilder` is the **current** API (the older `ephem::commit_accounts`/`commit_and_undelegate_accounts` belong to the pre-0.14 SDK).
- **Co-delegation rule (load-bearing, verified):** an instruction running in the ER requires **every account it touches to be delegated at that moment, to the *same* validator.** `open_position` touches `Market`+`Pool`+`UserBalance`+`Position`, so all four must be delegated to one ER validator. ⇒ pin the **same `validator`** in every `DelegateConfig`, and never route a trade through an account mid-undelegation. Per-account delegation lifecycles are independent (confirmed) — the shared Market/Pool can stay delegated while users delegate/undelegate their own accounts — but they must share the validator.

## Who delegates what, and when

| Account | Delegated by | When |
|---|---|---|
| `Market`, `LiquidityPool` | admin / keeper | once at **session start**; stay delegated all session |
| `UserBalance`, `Position` | the trader | when the trader **starts trading**; undelegated to withdraw |

The shared market/pool are delegated for the whole demo. Each trader delegates only their own two accounts.

## Flow 1 — LP seeds liquidity (all L1, before the session)

```
LP ──deposit_liquidity(amount)──► [L1]
   USDC: lp_ata → ShearVault
   shares minted (1:1 first deposit minus MIN_LIQUIDITY; else amount*shares/aum)
   pool.pool_usdc += amount
```
v0 constraint: LP deposit/withdraw happen while `LiquidityPool` is **undelegated** (session boundary). Mid-session LP flow is v1 (requires commit → L1 op → re-delegate).

## Flow 2 — Trader onboards and trades

```
1. deposit_collateral(amount)        [L1]  usdc: trader_ata → ShearVault ; free_collateral += amount
2. create_session_token(validUntil)  [client] ephemeral key funded for gasless txs
3. delegate_user                     [L1]  UserBalance (+ new Position PDA) → ER
   (Market + Pool already delegated by keeper)
4. open_position(side, C, lev)       [ER]  fills at oracle ratio, locks C, updates OI   ← gasless, 1-click
   … ratio moves, funding accrues via crank, equity tracked live …
5. close_position()                  [ER]  settles uPnL+funding+fee vs pool; free_collateral += settlement
6. commit_and_undelegate_user        [ER→L1] UserBalance committed, ownership returned
7. withdraw_collateral(amount)       [L1]  usdc: ShearVault → trader_ata
```

Steps 4–5 are the hot path: sub-50ms, zero fee, no wallet popup. Steps 1/7 are the only real-money L1 transactions.

## Flow 3 — Funding (crank, `crank-counter` pattern)

Registered once: `schedule_task(ScheduleTaskArgs { task_id, execution_interval_millis: 1000, iterations, instructions: vec![accrue_funding_ix] })`, `invoke_signed` to `MAGIC_PROGRAM_ID`. The scheduler **replays the embedded instruction** against the SHEAR program every interval, re-entering `accrue_funding(market)` — which advances `cum_funding` from the live skew. No external keeper. The registering `payer` funds the task.

## Flow 4 — Liquidation

Two paths, both [ER]:
- **Permissionless**: any `liquidator` calls `liquidate(position)` when underwater, earns the reward. The backstop.
- **Crank**: `crank_liquidations` scheduled (~100ms–1s) scans up to K positions/tick (passed in `remaining_accounts`, validated manually) and liquidates the underwater ones. Free per-block checks are the MagicBlock-only capability.

```
crank tick ─► read oracle R_t ─► for each position: equity < MMR·N ?
                                   ├─ yes → close at R_t, penalty split, OI/reserve update
                                   └─ no  → skip
```

## Flow 5 — Withdraw with profit (value conservation across the boundary)

The ER says a winning trader's `free_collateral` grew (pool paid them synthetically). On undelegate, that balance commits to L1. `withdraw_collateral` then transfers real USDC out of `ShearVault` — which physically holds it because LP deposits + all trader collateral are pooled there. Net is conserved: trader gains = LP losses (+ losers' losses), all inside one vault.

**Invariant checked at withdraw:** `amount <= free_collateral` and `ShearVault.amount >= amount`. Both always hold given the global invariant in `state.md §7` / `edge-cases.md`.

**Free-margin check (general form).** A withdraw must never leave a trader undercollateralized:
```
max_withdraw = free_collateral − IMR_remaining − unsettled_funding
```
where `IMR_remaining` is the initial margin of any positions still open after the withdraw. **v0 simplifies this**: `withdraw_collateral` requires all positions closed, so `IMR_remaining = 0` and the check reduces to `max_withdraw = free_collateral` (funding is already settled into collateral at close). The frontend exposes a "close all, then withdraw" button.

## Settlement / boundary edge cases

- **ER halt mid-session** → the last committed base-layer state wins; ER trades after the last commit are lost. Bounded by `commit_frequency_ms` (auto-commit cadence); set it tight enough that the replay distance is acceptable, plus one final `commit_and_undelegate` at session end.
- **Admin pause during a session** (`Market.status = Halted`/`ReduceOnly`) → new opens rejected; existing positions keep accruing funding and stay liquidatable. This **drains** positions cleanly before any undelegate, rather than trapping them.
- **Open position during `commit_and_undelegate`** → rejected; the account is in a transient ownership state until it returns to base.
- **Withdraw with an open position (v0)** → rejected (`CloseAllFirst`/positions-must-be-flat). The UI shouldn't surface withdraw until the book is flat.

## Session keys (gasless, `session-keys` pattern)

- Client: `SessionTokenManager.createSessionV2(topUp, validUntil, topUpLamports)` mints a session-token PDA and a funded ephemeral keypair. `validUntil` = unix expiry (e.g. now + 1h).
- Program: trading instructions accept an optional `session_token`. Authorization passes if the signer is `user_balance.owner` **or** a valid, unexpired `session_token` whose `authority == owner`. Because `UserBalance` is delegated (owner changed), the check is **manual**: deserialize the session token, verify `authority`, expiry, and that the signer matches the session key.
- Effect: the trader approves **once**; subsequent `open/close` in the ER are signed by the ephemeral key — no popup, no fee — until `validUntil`. This is what makes it feel like a CEX.

## Crank task details (verify against SDK before building)

- `ScheduleTaskArgs { task_id: i64, execution_interval_millis: u64, iterations: u64, instructions: Vec<Instruction> }`. `task_id` is the cancellation handle.
- The scheduled instruction must succeed using **only the accounts embedded at schedule time** — so `accrue_funding` embeds `market`; `crank_liquidations` embeds `market`, `pool`, feeds, and a fixed position set (or we re-schedule with a rotating window).
- **To confirm in docs/SDK**: the `iterations` value for "run forever", the cancel-task instruction variant, and the ER per-task CU ceiling. Flagged, not assumed.

## Session-boundary summary (v0 constraints, stated honestly)

- LP deposit/withdraw: pool undelegated (before/after session).
- Trader collateral deposit/withdraw: `UserBalance` undelegated (onboarding / cash-out).
- Active trading (open/close/modify/liquidate/funding): all delegated, in the ER.
- These constraints keep custody on L1 and the boundary auditable. Removing them (mid-session deposits) is a v1 capital-efficiency upgrade, not needed for the demo.
