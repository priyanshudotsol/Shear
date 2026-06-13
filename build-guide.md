# SHEAR — Build Guide

How to actually build it: repo layout, pinned dependencies, setup, milestone order, and the test plan. Targets Solana devnet + MagicBlock devnet ER. No mainnet.

## Pinned dependency set (verified against real examples — see `magicblock-integration.md §0`)

> An earlier draft pinned Anchor 0.32.1 + pyth-solana-receiver-sdk 1.2.0. **That was wrong** for the current stack: every current MagicBlock ER example pins **Anchor 1.0.2 + ephemeral-rollups-sdk 0.14.3**, and **no `pyth-solana-receiver-sdk` release targets Anchor 1.0.x**. The conflict and the three resolution paths are detailed in `magicblock-integration.md §0`. **We build on Path A** and remove the pyth dependency entirely by vendoring the tiny `PriceUpdateV2` reader.

```toml
# programs/shear/Cargo.toml  — Path A (recommended)
[dependencies]
anchor-lang = { version = "1.0.2", features = ["init-if-needed"] }
anchor-spl  = "1.0.2"
ephemeral-rollups-sdk = { version = "0.14.3", features = ["anchor"] }
magicblock-magic-program-api = { version = "0.10.1", default-features = false }   # crank: ScheduleTask/CancelTask
bincode = "1.3"                          # crank instructions are bincode-serialized
session-keys = { version = "3.1.1", features = ["no-entrypoint"] }                # SessionTokenV2 (gasless)
# Oracle: NO pyth-solana-receiver-sdk dep — vendor PriceUpdateV2 + get_price_no_older_than (oracle.md / §below).

[profile.release]
overflow-checks = true          # MANDATORY — fixed-point math must trap overflow

[features]
default = []
idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]
```

Fallbacks if Path A's `cargo build` won't resolve (in order): **B** = Anchor 0.32.1 + `ephemeral-rollups-sdk 0.14.3` feature `anchor-compat` + `pyth-solana-receiver-sdk 1.2.0` (real pyth, deprecated path); **C** = the battle-tested stack the live oracle program ships on: Anchor 0.31.1 + `ephemeral-rollups-sdk 0.2.x` + `pyth-solana-receiver-sdk 0.6.0/1.0.1` + `solana-program 2.2.x` (proven to build + read the oracle, but **no crank** and old commit API). See `magicblock-integration.md §0`.

## Exact external APIs (verbatim-confirmed from examples)

```rust
// ephemeral-rollups-sdk 0.14.3 (feature "anchor")
use ephemeral_rollups_sdk::anchor::{ephemeral, delegate, commit};
use ephemeral_rollups_sdk::cpi::DelegateConfig;             // { commit_frequency_ms: u32, validator: Option<Pubkey> }
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder; // .commit(&[..]) / .commit_and_undelegate(&[..]) ; call acct.exit(&crate::ID)? first
use ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;        // "Magic11111111111111111111111111111111111111"

// crank — magicblock-magic-program-api 0.10.1
use magicblock_magic_program_api::{args::ScheduleTaskArgs, instruction::MagicBlockInstruction};
// ScheduleTaskArgs { task_id: i64, execution_interval_millis: i64, iterations: i64, instructions: Vec<Instruction> }
// bincode::serialize(&MagicBlockInstruction::ScheduleTask(args)) -> invoke_signed to MAGIC_PROGRAM_ID

// session keys — session-keys 3.1.1
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

// oracle (VENDORED PriceUpdateV2 — see oracle.md):
// pu.get_price_no_older_than(&Clock::get()?, max_age, &feed_id)?  where feed_id = price_account.key().to_bytes()
```

Anchor sizing: `space = 8 + T::INIT_SPACE` with `#[derive(InitSpace)]`. Sizes computed in `state.md`.

## Repo layout

```
shear/
├─ Anchor.toml
├─ Cargo.toml                      # workspace (members=[programs/shear]; excludes shear-math)
├─ programs/
│  ├─ shear-math/                  # ✅ DONE — zero-dep, offline-tested core logic (30 tests passing)
│  │  └─ src/
│  │     ├─ lib.rs                 #   primitives: ratio, pnl, margin, funding, liq, shares
│  │     └─ engine.rs              #   state transitions: open/close/liquidate/funding/LP + invariants
│  └─ shear/
│     ├─ Cargo.toml                # anchor 1.0.2 + ERS 0.14.3 + magic-program-api + shear-math (path)
│     └─ src/
│        ├─ lib.rs                 # ✅ the walking-skeleton SPIKE (delegate→ER→oracle→crank→commit)
│        ├─ vendored_pyth.rs       # ✅ minimal PriceUpdateV2 reader (Path A)
│        ├─ state.rs               # ✅ real accounts + enums (state.md)
│        ├─ error.rs               # ✅ ShearError + From<EngineError>
│        ├─ events.rs              # ✅ events
│        ├─ oracle.rs              # TODO read_ratio() wrapper (logic is in shear-math)
│        └─ instructions/          # TODO thin Anchor wrappers over shear_math::engine
│           ├─ admin.rs            #   initialize_config, create_market, set_market_status
│           ├─ liquidity.rs        #   deposit/withdraw_liquidity
│           ├─ collateral.rs       #   deposit/withdraw_collateral
│           ├─ session.rs          #   delegate_* / commit_and_undelegate_*
│           ├─ trade.rs            #   open_position, close_position, add/remove_collateral
│           ├─ funding.rs          #   accrue_funding
│           └─ liquidation.rs      #   liquidate, crank_liquidations
├─ tests/
│  ├─ shear-spike.ts               # ✅ spike driver (SPIKE.md)
│  ├─ integration.ts               # TODO devnet + ER end-to-end
│  └─ scenarios.ts                 # TODO the demo scenarios
├─ app/                            # TODO Next.js frontend (frontend.md)
└─ scripts/                        # TODO deploy, seed-market, seed-liquidity, register-crank
```

**Logic lives in `shear-math` (pure, tested), Anchor handlers are thin wrappers.** The instruction handlers read Anchor accounts → call `shear_math::engine::{open_position, close_position, liquidate, accrue_funding, lp_deposit, …}` with plain field values → write back + emit events. This is why the full instruction logic is already exhaustively unit-tested offline before any of the `instructions/*` wrappers exist.
```

## Build order (load-bearing first — do NOT reorder)

1. **`math.rs` + `tests/math.rs`.** Pure functions, no Anchor. Implement every formula in `MATH.md` and pass all 7 property tests. This is the only place with real logic; get it provably right before anything else.
2. **`state.rs` + `error.rs` + `events.rs`.** Accounts, enums, errors (`state.md`, `instructions.md`).
3. **`oracle.rs`.** `read_ratio()` with the two-feed guards (`oracle.md`). Unit-test with mock `PriceUpdateV2`.
4. **Admin + collateral + liquidity instructions** (`initialize_config`, `create_market`, `deposit_collateral`, `deposit_liquidity`). L1 only — testable without the ER.
5. **`open_position` / `close_position`** against the pool. Test on L1 first (delegation off), then delegated.
6. **`liquidate`** + `accrue_funding`.
7. **Delegation + session wiring** (`session.rs`); route trades to the ER via the Magic Router.
8. **Crank**: register `accrue_funding` + `crank_liquidations` via `ScheduleTask`. Profile CU; tune batch size K.
9. **Param tuning** against the demo scenario (`MATH.md §11`).
10. **Frontend** (`frontend.md`) + the demo scenario script.

## Endpoints & infra (devnet)

| What | Value |
|---|---|
| Base RPC | `https://api.devnet.solana.com` |
| ER endpoint | `https://devnet.magicblock.app` |
| Magic Router | `https://devnet-router.magicblock.app` (ws: `wss://devnet-router.magicblock.app`) |
| Oracle program | `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd` (verify) |
| Feeds | SOL/USD, ETH/USD accounts in `oracle.md` (verify) |
| USDC | devnet mock mint (create your own) |

## Deploy / run scripts

1. `anchor build && anchor deploy` to devnet.
2. `scripts/init.ts` → `initialize_config`.
3. `scripts/seed-market.ts` → `create_market("SOL-ETH", …)` binding the two feeds.
4. `scripts/seed-liquidity.ts` → mint mock USDC, `deposit_liquidity` (protocol seeds first deposit per `edge-cases.md §1`).
5. `scripts/delegate-shared.ts` → delegate `Market` + `LiquidityPool` to the ER.
6. `scripts/register-crank.ts` → schedule `accrue_funding` (1s) + `crank_liquidations` (≤1s).
7. `app` reads ER state + oracle feeds over WS.

## Test plan

**Unit / property (`tests/math.rs`)** — the 7 invariants in `MATH.md §13`: market neutrality (exact 0 on common move), PnL sign, liquidation boundary, funding zero-sum-to-pool, pool conservation, determinism, overflow extremes. Plus share-math: first-deposit MIN_LIQUIDITY, 0-share rejection, donation immunity.

**Integration (`tests/integration.ts`)** — full Flow 2 (`lifecycle.md`): deposit → delegate → open → (oracle move) → close → undelegate → withdraw; assert custody + conservation invariants (`edge-cases.md`) before/after. Liquidation: open near max leverage, push the mock ratio, assert crank liquidates and pool/insurance accounting balances. Oracle guards: stale/zero/wide-conf feeds must reject.

**Scenario (`tests/scenarios.ts`)** — the demo: long `SOL-ETH` 10x, scripted SOL −8% / ETH −12%, assert SHEAR position green (+~45% on collateral) while a simulated directional long-SOL 10x liquidates.

## Definition of done (pre-submission)

- [ ] All property + integration tests green.
- [ ] Custody & conservation invariants asserted in tests.
- [ ] Deployed to devnet; market + liquidity seeded; crank registered.
- [ ] Gasless open/close via session key works end-to-end in the ER.
- [ ] Demo scenario reproduces the market-neutral result on-chain.
- [ ] Oracle/feed pubkeys + SDK feature names verified against live sources (the flagged TODOs).
- [ ] README, demo video, submission writeup done.
