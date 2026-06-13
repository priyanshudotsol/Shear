# SHEAR — Walking-Skeleton Spike

Goal: prove the **whole MagicBlock integration compiles and runs** on one PDA before building the real program. It exercises every primitive SHEAR needs: delegate → mutate in ER → read two oracle feeds → divide via the (tested) math crate → schedule a crank → commit/undelegate. If this walks, the rest is filling in the spec.

This validates the open items from `magicblock-integration.md §8`:
1. Path A `cargo build-sbf` resolves + the vendored `PriceUpdateV2` decodes a live feed.
2. The 3 oracle feed pubkeys are real (`getAccountInfo`).
3. Crank `iterations` "run forever" sentinel.
4. Crank account-set + CU.

---

## STATUS — contract builds + tests pass

- `anchor build` (anchor 1.0.2 via `avm use 1.0.2`) → green; IDL at `target/idl/shear.json`.
- **Engine logic: 44 unit tests, 99.42% line coverage** — `cd crates/shear-math && cargo llvm-cov --summary-only`
  (engine.rs 99.35%, lib.rs 99.59%). This is where the math/accounting/conservation lives.
- **`anchor test --validator legacy` → 15 passing** (localnet; anchor 1.0.2 defaults to `surfpool`,
  not installed, so pass `--validator legacy`). Covers all 16 localnet-testable instructions with
  EXACT account-state + emitted-event + numeric-outcome assertions, via a `mock-oracle` program +
  custody/conservation invariants.
- **`tests/integration.ts` → 4 passing on the LIVE MagicBlock devnet ER** (program deployed to
  devnet at `6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi`). Run:
  `ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/devnet-trading-wallet.json npx ts-mocha -p ./tsconfig.json -t 1000000 tests/integration.ts`.
  Proves on real infra: `create_market` reading the live SOL/USD + ETH/USD feeds; all 4
  `delegate_*` (market/pool/user_balance/position); a full open→accrue→close→`undelegate_trader`
  (commit_and_undelegate) cycle that **conserves USDC** (pool read live from the ER, trader accounts
  read post-commit on L1); and `schedule_funding_crank` — the crank fires `accrue_funding`
  autonomously (market `last_funding_ts` advances with no tx from us), resolving TODO #3/#4.
- Not separately exercised: `commit_trader` (the no-undelegate variant — same
  `MagicIntentBundleBuilder.commit()` path that `undelegate_trader` already proves) and
  `cancel_crank` (needs the MagicBlock task_context PDA; the reference example never cancels and the
  crank self-terminates after `iterations`).

## 0. The math is already proven (offline, no network)

```bash
cd programs/shear-math && cargo test
# 11 passed — ratio, PnL, margin, funding, liquidation, LP shares, overflow, the demo example
```
This is the load-bearing logic; it has zero deps and is verified independent of the platform.

---

## 1. Prerequisites

- Solana CLI (have: 3.1.15) + a devnet keypair: `solana-keygen new`, `solana config set --url devnet`, `solana airdrop 2`.
- Network access to crates.io + devnet (this repo's sandbox had crates.io blocked — run the build on your machine).
- **Anchor version — read this.** Installed `anchor-cli` is **0.31.1**, but Path A targets **anchor-lang 1.0.2**. Two options:
  - **Path A (recommended, has the crank + `MagicIntentBundleBuilder`):** `avm install 1.0.2 && avm use 1.0.2`, then `anchor build`. Or skip the CLI and build the program directly with `cargo build-sbf` (it uses the crate version in `Cargo.toml`, not the CLI) and only use `anchor`/`solana` for deploy.
  - **Path C fallback (matches installed anchor-cli 0.31.1, but NO crank):** edit `programs/shear/Cargo.toml` to `anchor-lang = "0.31.1"`, `ephemeral-rollups-sdk = { version = "0.2.x", features = ["anchor"] }`, and consume the oracle via the real `pyth-solana-receiver-sdk = "0.6.0"` (delete `vendored_pyth.rs`, import `pyth_solana_receiver_sdk::price_update::PriceUpdateV2`). The commit API on ERS 0.2.x is the older `ephem::commit_and_undelegate_accounts` — adjust `commit_state`/`undelegate`. Skip `schedule_crank` (no crank pre-0.14). Use this only if Path A won't resolve.

The whole point of the spike is to find out which path actually `cargo build-sbf`s — do that first.

## 2. Build

```bash
# from shear/
anchor keys sync                 # replace the placeholder program id in lib.rs + Anchor.toml
cargo build-sbf                  # or: anchor build   (Path A: ensure anchor 1.0.2 via avm)
```
**TODO #1 lands here.** If Path A resolves and `vendored_pyth.rs` compiles, proceed. If the dependency graph won't unify (anchor ⨯ pyth ⨯ ERS), switch to Path B then C per `magicblock-integration.md §0`. Record what worked in that doc.

## 3. Deploy to devnet

```bash
anchor deploy --provider.cluster devnet
# note the program id; set it in Anchor.toml [programs.devnet] + lib.rs declare_id!
```

## 4. Verify the oracle feeds (TODO #2)

```bash
# confirm each feed account exists, is owned by the oracle program, and decodes as PriceUpdateV2
solana account ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu --url https://devnet.magicblock.app   # SOL/USD
solana account 5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG --url https://devnet.magicblock.app   # ETH/USD
```
Oracle program id (expected owner): `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`.

## 5. Run the walking skeleton

`tests/shear-spike.ts` drives the sequence (wire the exact client calls from the example tests —
`anchor-counter` for delegate/commit routing, `crank-counter` for the schedule call):

```
initialize()                         # L1: create probe
delegate([validator])                # L1: probe → ER (pin the validator)
increment()        x N               # ER: mutate (sent to the ER endpoint)
store_ratio(max_age=60)              # ER: read SOL/USD + ETH/USD → ratio (logs "ratio(1e9) = ...")
schedule_crank(taskId, interval=1000, iterations=N)   # ER: crank fires increment every 1s
# wait, observe count climbing without sending txs  → crank works (TODO #3/#4)
commit_state()                       # ER→L1: checkpoint
undelegate()                         # ER→L1: return ownership; read probe on base layer
```

Endpoints (from the examples): base `https://api.devnet.solana.com`; ER `https://devnet.magicblock.app` (ws `wss://devnet.magicblock.app`); router `https://devnet-router.magicblock.app`. Route delegate/commit/undelegate per `anchor-counter`'s two-provider pattern.

## 6. Success criteria

- ✅ `cargo build-sbf` resolves on a chosen path (records the winning dependency set).
- ✅ `store_ratio` logs a sane `ratio(1e9)` (~`52_000_000` for SOL/ETH ≈ 0.052) — proves the vendored reader decodes a real feed and the math crate runs on-chain.
- ✅ `increment` mutates in the ER (fast, no base-layer tx); `count` rises.
- ✅ `schedule_crank` makes `count` climb with no further txs — proves the crank.
- ✅ `undelegate` returns the latest `count`/`last_ratio` to the base layer.

If all five pass, **green-light the full build** and start filling in `state.rs` / `instructions/*` from the spec. If the crank's `iterations`-forever or account-set behavior surprises you (TODO #3/#4), note the finding in `magicblock-integration.md §4/§8`.

## Files

- `programs/shear-math/` — the proven pure-math crate (offline-tested).
- `programs/shear/src/lib.rs` — the spike program (this skeleton).
- `programs/shear/src/vendored_pyth.rs` — minimal `PriceUpdateV2` reader (Path A).
- `tests/shear-spike.ts` — client driver (wire from the example tests).
