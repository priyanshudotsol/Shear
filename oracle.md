# SHEAR — Real-Time Pricing Oracle Integration

How SHEAR reads prices and turns **two** USD feeds into one live ratio. The one structural difference from a single-asset venue (SHIM/SLIP): every priced action reads *two* feeds and divides on-chain.

## TL;DR

- **Oracle:** MagicBlock real-time-pricing-oracle (Pyth-Lazer-fed, push model), live on devnet, delegated to the MagicBlock devnet ER.
- **Program ID (verify before build):** `PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd`
- **Network:** Solana devnet, ER at `https://devnet.magicblock.app`.
- **Role:** SHEAR is a **read-only** consumer. We read both feeds in `open_position`, `close_position`, `liquidate`, and `accrue_funding` (for skew it doesn't need price, but funding ticks alongside).
- **Import:** `pyth_solana_receiver_sdk` for the `PriceUpdateV2` deserializer.
- **The ratio is computed on-chain** from the two feeds (`MATH.md` §2) — we never store or trust an off-chain ratio.

## Available price feeds on devnet ER

SHEAR v0 uses **SOL/USD + ETH/USD** for the `SOL-ETH` market. BTC/USD is listed for the `SOL-BTC` / `ETH-BTC` expansion. **Verify these accounts against the live oracle repo before hardcoding** — they are deployment-specific.

| Asset | Provider | Feed account (verify) |
|---|---|---|
| **SOL/USD** | Pyth Lazer | `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` |
| **ETH/USD** | Pyth Lazer | `5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG` |
| BTC/USD | Pyth Lazer | `71wtTRDY8Gxgw56bXFt2oc6qeAbTxzStdNiC425Z51sr` |
| USDC/USD | Pyth Lazer | `Ekug3x6hs37Mf4XKCDptvRVCSCjJCAD7LKmKQXBAa541` |

A `Market` stores `base_feed` and `quote_feed` (the two pubkeys above) plus the canonical Pyth `feed_id` for each, so the handler can bind and reject a misrouted feed (`FeedMismatch`).

## How SHEAR uses the oracle

One read path, two feeds, divided. Same staleness discipline everywhere; execution paths are strictest.

### Execution ratio (inside `open_position` / `close_position` / `liquidate`)

Read **both** `PriceUpdateV2` accounts, enforce freshness on **each**, then compute `R_t` per `MATH.md` §2. This single `R_t` is used for the fill, PnL, equity, and the liquidation check — exactly like a single mark, but it's a ratio of two.

Staleness tolerance: **`MAX_AGE = 2s`** on each feed. If *either* feed is stale → reject with `OracleStale`; the trader retries next tick. A stale leg means a mispriced ratio, which is worse than a single mispriced mark, so this guard is non-negotiable.

Confidence: v0 uses the conservative additive bound `rel_conf ≈ conf_BASE/price_BASE + conf_QUOTE/price_QUOTE`. The tighter, first-order-correct form (independent leg errors add in quadrature) is `rel_conf = sqrt((conf_BASE/price_BASE)² + (conf_QUOTE/price_QUOTE)²)`; either is acceptable — additive simply rejects slightly more. `conf_mark = R_t × rel_conf`. If `rel_conf` exceeds `MAX_RATIO_CONF_BPS` (default 50 bps) → reject with `OracleUncertain`. Two feeds means confidence compounds, so SHEAR is stricter here than a single-asset venue.

**Staleness asymmetry (trader-paths fail loud, crank-paths fail safe).** Trader-initiated priced actions (`open_position`, `close_position`, `liquidate`, pre-withdraw equity check) **hard-error** on a stale/uncertain feed so the caller knows and retries. Crank-driven paths (`crank_liquidations`) instead **skip-and-retry**: emit `OracleStaleSkipped`, perform no liquidations this tick, return `Ok` so the crank stays alive. Opportunistic protocol work must never brick on one stale tick; trader actions must never silently misprice. (`accrue_funding` needs no oracle — it's skew-based.)

### NAV / display reads (pool NAV, position health in the UI)

Less time-critical. A 5s stale ratio is fine for *display*; it is load-bearing only at withdraw/liquidation gating, which use the 2s execution path.

## Reading the ratio inside the program

### 1. Deps & the `feed_id` correction

**Path A (recommended, `magicblock-integration.md §0`): do NOT add `pyth-solana-receiver-sdk`** — it can't coexist with Anchor 1.0.2. Instead **vendor** the small `PriceUpdateV2` struct + `get_price_no_older_than` (≈80 lines; `PriceUpdateV2 { write_authority, verification_level, price_message: PriceFeedMessage, posted_slot }`, `PriceFeedMessage { feed_id, price: i64, conf: u64, exponent: i32, publish_time, … }`). The MagicBlock oracle writes the **V2** layout (confirmed by its README). On fallback Paths B/C you instead depend on `pyth-solana-receiver-sdk` (1.2.0 or 0.6.0).

**CORRECTION — `feed_id` is the price-update account's own pubkey bytes, not a Pyth hex id.** The MagicBlock oracle sets `feed_id = price_account.key().to_bytes()`. So we do **not** use `get_feed_id_from_hex`, and `Market` does **not** need stored `base_feed_id`/`quote_feed_id` fields — they equal `base_feed`/`quote_feed`'s bytes. `get_price_no_older_than(&clock, max_age, &feed_id)` returns a `Price { price: i64, conf: u64, exponent: i32, publish_time: i64 }`.

### 2. Accept both feeds as `AccountInfo`, bound to the market

```rust
#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(mut, seeds = [b"market", market.key_seed.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,

    /// CHECK: PriceUpdateV2; bound by market.base_feed
    #[account(address = market.base_feed)]
    pub base_price: AccountInfo<'info>,

    /// CHECK: PriceUpdateV2; bound by market.quote_feed
    #[account(address = market.quote_feed)]
    pub quote_price: AccountInfo<'info>,

    // ... user_balance, position, pool
}
```

### 3. Compute the ratio (`src/oracle.rs`)

```rust
use crate::vendored_pyth::PriceUpdateV2;   // Path A: vendored; Paths B/C: pyth_solana_receiver_sdk::price_update::PriceUpdateV2

pub const RATIO_PRECISION: u128 = 1_000_000_000; // 1e9

pub fn read_ratio(
    base_ai: &AccountInfo,
    quote_ai: &AccountInfo,
    max_age: u64,
    max_conf_bps: u64,
) -> Result<u128> {
    let clock = Clock::get()?;
    // feed_id IS the account's own pubkey bytes (MagicBlock oracle convention)
    let base_feed_id  = base_ai.key().to_bytes();
    let quote_feed_id = quote_ai.key().to_bytes();
    let base = PriceUpdateV2::try_deserialize_unchecked(&mut &base_ai.data.borrow()[..])?;
    let quote = PriceUpdateV2::try_deserialize_unchecked(&mut &quote_ai.data.borrow()[..])?;

    // staleness + feed binding on BOTH (errors if stale or wrong feed)
    let p_base  = base.get_price_no_older_than(&clock, max_age, &base_feed_id)?;
    let p_quote = quote.get_price_no_older_than(&clock, max_age, &quote_feed_id)?;

    require!(p_base.price > 0 && p_quote.price > 0, ShearError::OracleStale);

    // confidence: ratio rel-conf ≈ conf_b/p_b + conf_q/p_q  (in bps)
    let conf_bps = (p_base.conf as u128 * 10_000 / p_base.price as u128)
                 + (p_quote.conf as u128 * 10_000 / p_quote.price as u128);
    require!(conf_bps <= max_conf_bps as u128, ShearError::OracleUncertain);

    // both crypto/USD feeds share expo (-8): divide directly, scaled to 1e9. Divide last.
    // if expos ever differ, normalize by 10^(expo_quote - expo_base) first.
    require!(p_base.exponent == p_quote.exponent, ShearError::FeedMismatch);

    let r = (p_base.price as u128)
        .checked_mul(RATIO_PRECISION).ok_or(ShearError::MathOverflow)?
        .checked_div(p_quote.price as u128).ok_or(ShearError::MathOverflow)?;
    Ok(r) // R_t scaled by 1e9
}
```

The returned `R_t` is the load-bearing number — it feeds entry/exit ratio, PnL, equity, and liquidation. (API names — `get_price_no_older_than`, `PriceUpdateV2` — match the Pyth receiver SDK; confirm the exact field names/signatures against the pinned crate version.)

### Notes on the read

- Both feeds are `i64 price` scaled by `10^expo` (expo typically `-8`). v0 asserts equal expos and divides directly; keep the `10^Δexpo` normalization handy if you ever pair feeds with different expos.
- `expo` cancels when both are equal — the ratio is dimensionless, which is why a 1e9-scaled integer ratio is exact.
- Funding (`accrue_funding`) needs only OI/skew, not price — but it's cheap to tick alongside.

## Frontend price subscription (WebSocket)

For the live ratio chart + PnL ticker, subscribe to **both** feeds and divide client-side so the UI re-ticks between trades:

```js
const ws = new WebSocket("wss://devnet.magicblock.app");
ws.onopen = () => {
  for (const feed of [SOL_USD, ETH_USD]) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "accountSubscribe",
      params: [feed, { encoding: "jsonParsed", commitment: "confirmed" }]
    }));
  }
};
// on each update: decode PriceUpdateV2 via @pythnetwork/pyth-solana-receiver,
// cache latest base/quote, render ratio = base/quote, recompute equity + liq-ratio
```

The ratio chart re-rendering on every oracle tick is the hero visual — the "repriced every millisecond" claim made visible. (Confirm the ER endpoint supports `accountSubscribe`/WS — treat the ~1ms render claim as bounded by the oracle's ~50–200ms push; see latency note below.)

## Latency reality (set expectations honestly)

End-to-end freshness is bounded by the **slowest stage**, not the ER block time. The MagicBlock pusher writes Lazer updates at **~50–200ms** (asset-dependent). So:
- The ER renders/recomputes every ~1ms, but the *underlying ratio* changes at the pusher cadence (~50–200ms). That's still 2–8× fresher than Solana L1 (~400ms) and orders of magnitude past sponsored push feeds (~1/min).
- Size `MAX_AGE` to the **pusher cadence** (2s is comfortably above 200ms), not to the ER slot.
- The demo claim is "continuous, sub-second repricing + free re-margining," which is true and defensible — not "literally a new price every 1ms."

## What we DON'T do

- We don't call `initialize_price_feed`, `update_price_feed`, `delegate_price_feed`, `undelegate_price_feed`, or `close_price_feed` — oracle-authority-only; feeds are already initialized + delegated.
- We don't push prices or run a pusher.
- We don't trust any off-chain ratio — the division happens on-chain from two verified feeds.
- We don't **auto-invert** markets at read time. An `ETH-SOL` market is a *separate* `Market` with the feeds swapped at `create_market`. Auto-inverting would double the mark-composition bug surface and flip the funding sign confusingly. A trader who wants the inverse just opens the opposite side, or trades the explicitly-created inverse market.

## Risks / caveats

- **Two feeds = double the stall risk.** If *either* SOL/USD or ETH/USD pusher stalls, every priced action rejects with `OracleStale`. Pre-flight **both** feeds before any demo.
- **Confidence adds across feeds.** Wider effective confidence than a single asset; `MAX_RATIO_CONF_BPS` may need loosening on volatile devnet — tune, but never disable.
- **Feed accounts/program ID are deployment-specific.** Verify all pubkeys against `magicblock-labs/real-time-pricing-oracle` before hardcoding (values above are from prior notes, not re-verified here).
- **Equal-expo assumption.** v0 asserts both feeds share `expo`. SOL/USD and ETH/USD both use `-8`, so this holds — but the assertion (`FeedMismatch`) prevents silent mispricing if it ever changes.
- **No mainnet oracle.** Devnet only, matching the deployment plan.

## Files of record in the oracle repo

- Program: `real-time-pricing-oracle/program/ephemeral-oracle/programs/ephemeral-oracle/src/lib.rs`
- State: `.../src/state.rs`
- Pusher service: `real-time-pricing-oracle/src/main.rs`
- Consumer example: `real-time-pricing-oracle/README.md`
