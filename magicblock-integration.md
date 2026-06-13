# SHEAR — MagicBlock Integration Map (verified)

**Purpose:** exactly where SHEAR uses MagicBlock, with the API confirmed **verbatim from the real example source** in `../magicblock-engine-examples/` (and the live oracle repo). Confidence is marked per item. The handful of things that can only be settled by `cargo build` / a live validator are listed at the end as **spike-time TODOs** — nothing else should block starting the build.

> This doc supersedes earlier version/oracle assumptions in `build-guide.md`, `oracle.md`, `state.md`. Where they disagree, **this file wins** until those are reconciled (tracked).

## 0. The dependency stack — the #1 pre-build decision

**Verified conflict:** the *current* MagicBlock ER examples (anchor-counter, crank-counter, session-keys, magic-actions, dummy-token-transfer) all pin **`anchor-lang 1.0.2` + `ephemeral-rollups-sdk 0.14.3` (feature `anchor`)** and use the **`MagicIntentBundleBuilder`** commit API. But **no `pyth-solana-receiver-sdk` release targets anchor 1.0.x** (1.2.0→anchor `0.32.1`; 1.0.1→`0.31.1`; 0.6.0→`>=0.28`). Anchor and pyth share `anchor-lang` proc-macros, so two majors can't co-resolve. And the live **oracle program itself** (`real-time-pricing-oracle`) ships on the *older* **anchor 0.31.1 + ephemeral-rollups-sdk 0.2.4 + pyth 0.6.0 + solana-program 2.2.1**, which uses the *old* `ephem::commit_accounts` API and predates the crank.

So we cannot have all of {newest ER SDK + crank + MagicIntentBundleBuilder + session-keys 3.1.1} **and** {pyth-solana-receiver-sdk} in one crate without choosing a lane. Three options, decreasing preference:

| Path | Stack | Pros | Cons |
|---|---|---|---|
| **A (recommended)** | `anchor 1.0.2` + `ephemeral-rollups-sdk 0.14.3 (anchor)` + `magicblock-magic-program-api 0.10.1` + `session-keys 3.1.1` + **read oracle by vendoring `PriceUpdateV2`** (no `pyth-solana-receiver-sdk` dep) | Current supported ER stack; crank + builder + session keys all work; oracle dep conflict *removed entirely* | We hand-port ~80 lines of `PriceUpdateV2` + `get_price_no_older_than` (low risk; layout is stable, README confirms V2) |
| **B (legacy, full-pyth)** | `anchor 0.32.1` + `ephemeral-rollups-sdk 0.14.3 (anchor-compat)` + `pyth-solana-receiver-sdk 1.2.0` | Keeps the real pyth crate; newest ER SDK that still supports legacy anchor | Deprecated `anchor-compat` path; **unproven** that anchor-compat resolves 0.32.x (may pin 0.31.x and force pyth→1.0.1); must confirm it still exposes `MagicIntentBundleBuilder` + crank |
| **C (battle-tested-old)** | `anchor 0.31.1` + `ephemeral-rollups-sdk 0.2.x` + `pyth-solana-receiver-sdk 0.6.0/1.0.1` + `solana-program 2.2.x` | **Exactly what the live oracle program compiles with** — guaranteed to build + read the oracle | Old ER SDK: **no crank** (funding/liq must use an off-chain ticker), old `ephem::commit_accounts` API, no `MagicIntentBundleBuilder`/`magic-actions` |

**Decision: build on Path A.** Rationale: the crank, the commit builder, and gasless session keys are all load-bearing for SHEAR and only exist on the current (1.0.2 / 0.14.3) stack; the *only* thing pulling us off it is pyth, and that dependency is trivially removable by vendoring the `PriceUpdateV2` reader (we already deserialize it manually with `try_deserialize_unchecked` anyway — see §5). **Spike step 1 is to confirm Path A's `cargo build` resolves and the vendored reader decodes a live feed; if vendoring fights us, fall back to B, then C.** This is the first hour of the spike.

```toml
# Path A (recommended) — programs/shear/Cargo.toml
[dependencies]
anchor-lang = { version = "1.0.2", features = ["init-if-needed"] }
anchor-spl  = "1.0.2"
ephemeral-rollups-sdk = { version = "0.14.3", features = ["anchor"] }
magicblock-magic-program-api = { version = "0.10.1", default-features = false }
bincode = "1.3"                     # crank ScheduleTask is bincode-serialized
session-keys = { version = "3.1.1", features = ["no-entrypoint"] }
# oracle: vendor PriceUpdateV2 + get_price_no_older_than (see oracle.md) instead of pyth-solana-receiver-sdk
[profile.release]
overflow-checks = true
```

## 1. Master map

| MagicBlock primitive | Where SHEAR uses it | Confidence | Verbatim source |
|---|---|---|---|
| **Delegation** (`#[ephemeral]`/`#[delegate]`/`#[commit]`, `delegate_pda`, `DelegateConfig`) | Delegate `Market`,`LiquidityPool` (session start) + per-user `UserBalance`,`Position` (on trade) | ✅ High | `anchor-counter`, `dummy-token-transfer` lib.rs |
| **Commit / undelegate** (`MagicIntentBundleBuilder`) | Settle ER state to L1 for withdraws + periodic checkpoints | ✅ High | `anchor-counter`, `dummy-token-transfer` |
| **Synthetic token balances** (u64/i128 on delegated PDA) | `free_collateral`, `pool_usdc`, position settlement — all in ER | ✅ High | `dummy-token-transfer` |
| **Real SPL custody on L1** (`token::transfer` CPI, program-owned vault) | `deposit/withdraw_collateral`, `deposit/withdraw_liquidity` — L1 only | ✅ High | `spl-tokens` lib.rs (CPI shape) |
| **Crank** (`ScheduleTask` via `magicblock-magic-program-api`) | `accrue_funding` (~1s) — clean fit | ✅ High | `crank-counter` lib.rs |
| **Crank for liquidation** (bounded/fixed account set) | `crank_liquidations` — **partial fit, see §4** | ⚠️ Medium | `crank-counter` + limitation |
| **Oracle read** (`PriceUpdateV2` + `get_price_no_older_than`) | Two feeds → ratio, in `open/close/liquidate` | ✅ High (program id) / ⚠️ Med (feed addrs) | `real-time-pricing-oracle` README |
| **Session keys** (`session-keys 3.1.1`, `SessionTokenV2`) | Gasless one-click `open/close` | ✅ High | `session-keys` lib.rs |
| **Magic Actions** (`CallHandler` + `add_post_commit_actions`) | *Optional:* auto-settle funding/PnL to L1 on commit | ✅ High | `magic-actions` lib.rs |
| **VRF / TEE** (`ephemeral-vrf`, private-counter) | Out of scope v0 (future: fair liq tie-break / private positions) | n/a | `rewards-delegated-vrf`, `private-counter` |

## 2. Delegation — confirmed

Macros: `#[ephemeral]` above `#[program]`; `#[delegate]` on the delegate Accounts struct with the PDA `#[account(mut, del)] pda: UncheckedAccount`; `#[commit]` on the commit/undelegate Accounts struct (injects `magic_context` + `magic_program`). Delegate call (verbatim shape):

```rust
ctx.accounts.delegate_pda(
    &ctx.accounts.payer,
    &[/* PDA seeds */],
    DelegateConfig {
        commit_frequency_ms: params.commit_frequency_ms, // u32
        validator: params.validator,                     // Option<Pubkey>
    },
)?;
```

**Confirmed facts that validate SHEAR's design:**
- **Per-account, independent lifecycles** — each account is delegated/undelegated in its own tx; delegation status lives on the account (owner flips to the delegation program). So a long-lived shared `Market`/`Pool` delegated for the session **+** per-user `UserBalance`/`Position` that delegate/undelegate independently **is directly supported** (verified across `spl-tokens` + `dummy-token-transfer`).
- **Co-delegation rule (important):** any instruction executing in the ER requires **every account it touches to be delegated at that moment, to the same validator.** `open_position` touches `Market`,`Pool`,`UserBalance`,`Position` → all four must be delegated to the **same** ER validator. ⇒ Pin one `validator` in `DelegateConfig` for *all* SHEAR accounts; never route a trade through an account that's mid-undelegation.
- Delegate program-owned **PDAs** via the in-program `delegate_pda` pattern (anchor-counter), **not** the client-side assign-owner flow (`oncurve-delegation` is for wallet accounts — not us).

## 3. Commit / undelegate — confirmed (current API)

Use `MagicIntentBundleBuilder`, **not** the deprecated `ephem::commit_accounts`. Verbatim:

```rust
// serialize the Anchor account first, then build the intent
ctx.accounts.user_balance.exit(&crate::ID)?;   // <-- REQUIRED before commit
MagicIntentBundleBuilder::new(
    ctx.accounts.payer.to_account_info(),
    ctx.accounts.magic_context.to_account_info(),
    ctx.accounts.magic_program.to_account_info(),
)
.commit(&[ctx.accounts.user_balance.to_account_info()])               // commit, stay delegated
// or .commit_and_undelegate(&[...])                                   // commit + return ownership
.build_and_invoke()?;
```

`commit_frequency_ms` in `DelegateConfig` also auto-commits on a cadence — use it so the ER→L1 replay distance is bounded if the ER halts.

## 4. Crank — confirmed, with one real limitation

`ScheduleTask` via `magicblock-magic-program-api 0.10.1`, bincode-serialized, `invoke_signed` to `MAGIC_PROGRAM_ID` (`Magic11111111111111111111111111111111111111`). Verbatim arg struct:

```rust
ScheduleTaskArgs { task_id: i64, execution_interval_millis: i64, iterations: i64, instructions: Vec<Instruction> }
// accounts on the CPI: [payer (signer,writable), task_context (writable), 2..n task accounts]
// cancel: MagicBlockInstruction::CancelTask { task_id }  with [task_authority(signer,writable), task_context(writable)]
```

- **`accrue_funding` → perfect crank fit.** It touches only the `Market` PDA (skew-based, no oracle), so the frozen embedded instruction `(program=SHEAR, accounts=[Market], data=accrue_funding)` re-fires every `execution_interval_millis` (use 1000). One account, fixed forever. ✅
- **`crank_liquidations` → partial fit (the limitation).** The crank re-issues a **frozen** instruction — the embedded `accounts` list is fixed at schedule time; there is **no `UpdateTask`** and **no demonstrated way to rotate/scan a changing set of position accounts.** Any position the handler touches must be in that fixed list. Consequences for SHEAR:
  - Primary liquidation path = **permissionless `liquidate`** (a tiny off-chain keeper, or any searcher, calls it per-underwater-position; zero ER fees make this cheap). This is the robust, always-correct path.
  - The crank can additionally sweep a **bounded, fixed set** (e.g. embed `Market`,`Pool`,feeds + up to K position PDAs), and we **cancel + re-`ScheduleTask`** when the active set changes. Fine for the demo (few positions) and a useful backstop; not a full dynamic scanner.
  - So the earlier "no external keeper for liquidations" claim is softened: **funding is fully keeper-free; liquidation realistically wants a thin keeper calling permissionless `liquidate`,** with the crank as a fixed-set backstop.

## 5. Oracle — confirmed read path (one correction)

- **Program id:** `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` (✅ high — matched across docs, README, repo, blog).
- **Feed accounts (devnet, ⚠️ medium — verify via `getAccountInfo` before hardcoding):** SOL/USD `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`, ETH/USD `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG`, BTC/USD `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr`.
- **Read (verbatim from the oracle README):**
  ```rust
  let pu = PriceUpdateV2::try_deserialize_unchecked(&mut (*acct.data.borrow()).as_ref())?;
  let feed_id: [u8; 32] = acct.key().to_bytes();           // <-- CORRECTION (see below)
  let p = pu.get_price_no_older_than(&Clock::get()?, max_age, &feed_id)?; // p.price i64, p.conf u64, p.exponent i32
  ```
- **CORRECTION to our `oracle.md`/`state.md`:** the `feed_id` is **the price-update account's own pubkey bytes** (`acct.key().to_bytes()`), **not** a Pyth hex id via `get_feed_id_from_hex`. ⇒ `Market` does **not** need separate `base_feed_id`/`quote_feed_id: [u8;32]` fields — they're derivable from `base_feed`/`quote_feed`. (Drop those two fields from `state.md` or mark them = account key.)
- **Freshness:** SOL/USD pushes at **200ms**, ETH/USD & BTC at **50ms**; the SOL/ETH ratio is gated by the slower **~200ms** leg. Both exponent `-8`. Our `MAX_AGE=2s` is comfortably safe.
- **Path A note:** we read the oracle by **vendoring** `PriceUpdateV2` + `get_price_no_older_than` (so we don't drag `pyth-solana-receiver-sdk`'s anchor pin into an anchor-1.0.2 program). The struct is `PriceUpdateV2 { write_authority, verification_level, price_message: PriceFeedMessage, posted_slot }`; `PriceFeedMessage` carries `feed_id, price, conf, exponent, publish_time, …`. ~80 lines, borsh layout, V2 confirmed by the README.

## 6. Session keys — confirmed (two auth paths)

Crate is **`session-keys 3.1.1`** (not `gpl-session`); token type **`SessionTokenV2`**; client uses `@magicblock-labs/gum-sdk`'s `SessionTokenManager.createSessionV2(topUp, validUntil, topUpLamports)`.

- **Non-delegated path** (program owns the typed account): `#[derive(Accounts, Session)]`, `session_token: Option<Account<'info, SessionTokenV2>>` with `#[session(signer = payer, authority = <owner>.key())]`, gate handler with `#[session_auth_or(<owner> == payer, SessionError::InvalidToken)]`. Macros do the validation.
- **Delegated path (SHEAR's actual trades — load-bearing):** the PDA is `UncheckedAccount` (owner = delegation program), so the macros **cannot** be used. Validate manually (verbatim pattern):
  ```rust
  let authority = { let d = ctx.accounts.position.try_borrow_data()?; Position::try_deserialize(&mut &d[..])?.owner };
  let session_ok = ctx.accounts.session_token.as_ref().map(|t| t.authority == authority).unwrap_or(false);
  require!(authority == ctx.accounts.signer.key() || session_ok, SessionError::InvalidToken);
  ```
  ⇒ `Position`/`UserBalance` must store an `owner`/`authority: Pubkey` field (they do). **Hardening to add** (the example omits it): also assert the `SessionTokenV2` is the canonical PDA `["session_token_v2", target_program, session_signer, authority]` and owned by the session program — important because these are funds-bearing trades.
- Client UX: one popup at `createSessionV2` (co-signed wallet + ephemeral key); thereafter ER trades are signed by `[sessionKeypair]` only (`payer: sessionKeypair.publicKey`, pass `sessionToken` PDA). Fully gasless.

## 7. Magic Actions — optional, for L1 auto-settlement

`magic-actions` shows `MagicIntentBundleBuilder::…commit(&[...]).add_post_commit_actions([CallHandler{ destination_program, accounts, args, escrow_authority, compute_units }]).build_and_invoke()` — fires a **base-layer instruction automatically when the ER commit lands.** SHEAR can use this to push funding/PnL to L1 on commit without a separate user tx. Ships without session keys, so we'd merge the two patterns. **Defer to post-MVP** unless we want clean auto-settlement in the demo.

## 8. Spike-time TODOs (the only things reading can't settle)

Resolve these in the first ~2 hours of the build, in order:
1. ✅ **RESOLVED — Path A compiles.** `cargo build-sbf` resolves and compiles the full dependency tree (anchor-lang 1.0.2 + anchor-spl 1.0.2 + ERS 0.14.3 + magic-program-api 0.10.1 + session-keys 3.1.1 + the vendored `PriceUpdateV2`). No version conflict — Path A is confirmed; B/C not needed. API notes learned while compiling: `CpiContext::new` takes the token-program **`.key()`** (Pubkey), not `.to_account_info()`; commit/undelegate need `use ephemeral_rollups_sdk::ephem::FoldableIntentBuilder` in scope for `.build_and_invoke()`; oracle program id via `Pubkey::from_str_const`. *(Still verify the vendored reader against a LIVE feed on devnet — §5.)*
2. **Verify the 3 feed-account pubkeys** via `getAccountInfo` on the ER RPC. Confirm program id owns them and they decode as `PriceUpdateV2`.
3. **Crank `iterations` "run forever" sentinel** — not documented in the example (it used `3`). Test `i64::MAX` / `0` / `-1` on a validator; until known, re-schedule periodically.
4. **Crank account-set & CU** — confirm the bounded position count a single `crank_liquidations` tick can carry, and that cancel+reschedule works. (Funding crank is unaffected — single fixed account.)
5. **anchor-compat resolution** (only if we take Path B) — confirm it pins anchor 0.32.x (not 0.31.x) so pyth 1.2.0 holds.

## 9. Verdict

We are **confident on *where* and *how* SHEAR uses every MagicBlock primitive** — delegation, commit/undelegate, synthetic-balance custody, the funding crank, the oracle read, and session keys are all confirmed against real source with exact APIs. The design assumptions held up: **independent per-account delegation works**, the **synthetic-balance + L1-escrow** model is right, and the **oracle read path is exactly as specced** (with the `feed_id` correction). The residual unknowns (§8) are all **`cargo build` / live-validator** questions, not design questions — which is precisely what the walking-skeleton spike is for. **Green light to start the spike on Path A.**
