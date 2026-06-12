//! SHEAR pure math — the load-bearing logic, with zero external dependencies so it
//! is provably correct in isolation (`cargo test`) before any Anchor/MagicBlock wiring.
//!
//! Source of truth: `MATH.md`. Conventions:
//!   ratio R  scaled by RATIO_PRECISION (1e9)
//!   funding cumulative index scaled by FUNDING_PRECISION (1e9)
//!   USDC amounts in base units (1e6)  — but the math is unit-agnostic
//!   rates/ratios (IMR/MMR/fees) in BPS (1e4)
//!   PnL / equity / funding are SIGNED (i128); balances are unsigned.
//! Rounding rule: round in favor of the pool / against the user (fees up, payouts down).

pub mod engine;

pub const RATIO_PRECISION: u128 = 1_000_000_000; // 1e9
pub const FUNDING_PRECISION: i128 = 1_000_000_000; // 1e9
pub const BPS: u128 = 10_000;
/// LP shares permanently locked on the first deposit (anti-inflation, `edge-cases.md §1`).
pub const MIN_LIQUIDITY: u128 = 1_000;
/// Funding accrues per this interval (skew funding, `MATH.md §7`).
pub const FUNDING_INTERVAL_SECS: i64 = 3600;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Long,
    Short,
}

impl Side {
    #[inline]
    pub fn sign(self) -> i128 {
        match self {
            Side::Long => 1,
            Side::Short => -1,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MathError {
    DivByZero,
    Overflow,
    BadPrice,
    DustDeposit,
}

type R<T> = Result<T, MathError>;

/// Ratio R = price_base / price_quote, scaled by 1e9. Both prices must be > 0 and
/// share the same exponent (asserted by the caller). Divide last.
pub fn compute_ratio(price_base: i64, price_quote: i64) -> R<u128> {
    if price_base <= 0 || price_quote <= 0 {
        return Err(MathError::BadPrice);
    }
    (price_base as u128)
        .checked_mul(RATIO_PRECISION)
        .ok_or(MathError::Overflow)?
        .checked_div(price_quote as u128)
        .ok_or(MathError::DivByZero)
}

/// Volatility-amplified ratio (relative-value index). Linearly amplifies the deviation of the
/// raw ratio from a reference anchor `ref_ratio` (R_0) by `amp_bps`/1e4:
///   R_amp = R_0 + (amp_bps/1e4) * (R_raw − R_0)
/// `amp_bps == 10_000` is 1x (identity); `ref_ratio == 0` or `amp_bps == 0` also pass through raw
/// (so an un-anchored / unconfigured market behaves exactly like the plain ratio). Result is
/// floored at 1 so a deep amplified drawdown can never produce a non-positive ratio.
pub fn amplify_ratio(raw: u128, ref_ratio: u128, amp_bps: u32) -> u128 {
    if ref_ratio == 0 || amp_bps == 0 || amp_bps as u128 == BPS {
        return raw;
    }
    let dev = (raw as i128) - (ref_ratio as i128);
    let scaled = dev * (amp_bps as i128) / (BPS as i128);
    let amped = (ref_ratio as i128) + scaled;
    if amped < 1 {
        1
    } else {
        amped as u128
    }
}

/// Notional N = collateral * leverage (USDC base units).
pub fn notional(collateral: u64, leverage: u16) -> R<u64> {
    (collateral as u128)
        .checked_mul(leverage as u128)
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(MathError::Overflow)
}

/// uPnL = side * N * (R_t / R_e − 1) = side * N * (R_t − R_e) / R_e  (signed USDC).
pub fn unrealized_pnl(side: Side, notional: u64, entry_ratio: u128, current_ratio: u128) -> R<i128> {
    if entry_ratio == 0 {
        return Err(MathError::DivByZero);
    }
    let diff = (current_ratio as i128) - (entry_ratio as i128);
    let num = (notional as i128).checked_mul(diff).ok_or(MathError::Overflow)?;
    Ok(side.sign() * (num / (entry_ratio as i128)))
}

/// funding_owed = side * N * (cum_now − cum_entry) / 1e9  (signed; +ve debits a long).
pub fn funding_owed(side: Side, notional: u64, cum_now: i128, cum_entry: i128) -> R<i128> {
    let d = cum_now.checked_sub(cum_entry).ok_or(MathError::Overflow)?;
    let num = (notional as i128).checked_mul(d).ok_or(MathError::Overflow)?;
    Ok(side.sign() * (num / FUNDING_PRECISION))
}

/// equity = collateral + uPnL − funding_owed − fees  (signed).
pub fn equity(collateral: u64, upnl: i128, funding_owed: i128, fees: u64) -> i128 {
    (collateral as i128) + upnl - funding_owed - (fees as i128)
}

/// Maintenance requirement = mmr_bps/1e4 * N  (USDC).
pub fn maintenance_margin(notional: u64, mmr_bps: u16) -> i128 {
    (((notional as u128) * (mmr_bps as u128)) / BPS) as i128
}

/// Liquidatable iff equity < MMR*N. (Caller may subtract a confidence buffer first.)
pub fn is_liquidatable(equity: i128, notional: u64, mmr_bps: u16) -> bool {
    equity < maintenance_margin(notional, mmr_bps)
}

/// Liquidation ratio: R_liq = R_e * (1e4 + s*(mmr − imr)) / 1e4, imr_bps = 1e4/leverage.
/// long → below entry; short → above entry.
pub fn liquidation_ratio(side: Side, entry_ratio: u128, leverage: u16, mmr_bps: u16) -> u128 {
    let imr_bps = (BPS / (leverage as u128)) as i128;
    let factor_num = (BPS as i128) + side.sign() * ((mmr_bps as i128) - imr_bps); // in 1e4 units
    (((entry_ratio as i128) * factor_num) / (BPS as i128)) as u128
}

/// Taker fee = ceil(N * fee_bps / 1e4)  (rounded up, against the user).
pub fn taker_fee(notional: u64, fee_bps: u16) -> u64 {
    let num = (notional as u128) * (fee_bps as u128);
    (((num + (BPS - 1)) / BPS)) as u64
}

/// skew = (long − short) * 1e9 / max(gross,1), clamped to [-1e9, 1e9].
pub fn skew(long_oi: u64, short_oi: u64) -> i128 {
    let gross = (long_oi as i128) + (short_oi as i128);
    if gross == 0 {
        return 0;
    }
    let s = ((long_oi as i128) - (short_oi as i128)) * FUNDING_PRECISION / gross;
    s.clamp(-FUNDING_PRECISION, FUNDING_PRECISION)
}

/// funding_rate per interval (1e9-scaled fraction) = clamp(k_bps/1e4 * skew, ±f_max_bps).
/// skew_1e9 ∈ [-1e9,1e9]; f_max_bps converted to 1e9 scale.
pub fn funding_rate(skew_1e9: i128, k_funding_bps: u32, f_max_bps: u32) -> i128 {
    let rate = (k_funding_bps as i128) * skew_1e9 / (BPS as i128);
    let f_max = (f_max_bps as i128) * FUNDING_PRECISION / (BPS as i128);
    rate.clamp(-f_max, f_max)
}

/// Advance the cumulative funding index: cum += rate * dt / interval  (1e9-scaled).
pub fn accrue_funding(cum: i128, rate_1e9: i128, dt_secs: i64, interval_secs: i64) -> R<i128> {
    if interval_secs <= 0 {
        return Err(MathError::DivByZero);
    }
    let delta = rate_1e9
        .checked_mul(dt_secs as i128)
        .ok_or(MathError::Overflow)?
        / (interval_secs as i128);
    cum.checked_add(delta).ok_or(MathError::Overflow)
}

/// LP shares minted for a deposit. First deposit: 1:1 minus MIN_LIQUIDITY (locked).
/// Subsequent: deposit * total_shares / aum, rounded DOWN.
pub fn shares_for_deposit(deposit: u64, total_shares: u128, aum: u64) -> R<u128> {
    if total_shares == 0 {
        let d = deposit as u128;
        if d <= MIN_LIQUIDITY {
            return Err(MathError::DustDeposit);
        }
        return Ok(d - MIN_LIQUIDITY);
    }
    if aum == 0 {
        return Err(MathError::DivByZero);
    }
    let shares = (deposit as u128)
        .checked_mul(total_shares)
        .ok_or(MathError::Overflow)?
        / (aum as u128);
    if shares == 0 {
        return Err(MathError::DustDeposit);
    }
    Ok(shares)
}

/// USDC returned for burning shares = aum * shares / total_shares, rounded DOWN.
pub fn usdc_for_shares(shares: u128, total_shares: u128, aum: u64) -> R<u64> {
    if total_shares == 0 {
        return Err(MathError::DivByZero);
    }
    let v = (aum as u128)
        .checked_mul(shares)
        .ok_or(MathError::Overflow)?
        / total_shares;
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// Net-OI utilization gate: |net_oi| <= pool_usdc * max_net_util_bps / 1e4.
pub fn within_net_util(long_oi: u64, short_oi: u64, pool_usdc: u64, max_net_util_bps: u16) -> bool {
    let net = ((long_oi as i128) - (short_oi as i128)).unsigned_abs();
    let cap = (pool_usdc as u128) * (max_net_util_bps as u128) / BPS;
    net <= cap
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helpers
    fn ratio(pb: i64, pq: i64) -> u128 {
        compute_ratio(pb, pq).unwrap()
    }

    // §13.1 — Market neutrality: a common factor on both legs leaves the ratio (and uPnL) unchanged, EXACTLY.
    #[test]
    fn market_neutrality_is_exact() {
        let cases = [(150_00000000i64, 3000_00000000i64), (138_00000000, 2640_00000000), (7_12345678, 99_87654321)];
        for &(pb, pq) in &cases {
            let r_e = ratio(pb, pq);
            for k in [2i64, 3, 5, 7, 10, 137] {
                let r_t = ratio(pb * k, pq * k);
                assert_eq!(r_e, r_t, "ratio must be invariant to common factor k={k}");
                for side in [Side::Long, Side::Short] {
                    for n in [1u64, 1_000_000, 1_000_000_000] {
                        assert_eq!(
                            unrealized_pnl(side, n, r_e, r_t).unwrap(),
                            0,
                            "uPnL must be exactly 0 when the ratio is unchanged"
                        );
                    }
                }
            }
        }
    }

    // §13.2 — PnL sign: long profits iff R_t > R_e; short is the mirror.
    #[test]
    fn pnl_sign() {
        let r_e = ratio(150_00000000, 3000_00000000); // 0.05
        let r_up = ratio(165_00000000, 3000_00000000); // SOL up → ratio up
        let r_dn = ratio(135_00000000, 3000_00000000); // SOL down → ratio down
        let n = 1_000_000_000u64;
        assert!(unrealized_pnl(Side::Long, n, r_e, r_up).unwrap() > 0);
        assert!(unrealized_pnl(Side::Long, n, r_e, r_dn).unwrap() < 0);
        assert!(unrealized_pnl(Side::Short, n, r_e, r_up).unwrap() < 0);
        assert!(unrealized_pnl(Side::Short, n, r_e, r_dn).unwrap() > 0);
    }

    // §11 — the demo worked example (10x long SOL-ETH, SOL −8% / ETH −12%).
    #[test]
    fn worked_example_demo() {
        let r_e = ratio(150_00000000, 3000_00000000); // 0.05 → 50_000_000
        assert_eq!(r_e, 50_000_000);
        let r_t = ratio(138_00000000, 2640_00000000); // 0.052272... → 52_272_727
        assert_eq!(r_t, 52_272_727);
        let n = notional(100_000_000, 10).unwrap(); // 100 USDC * 10x = 1000 USDC
        assert_eq!(n, 1_000_000_000);
        let pnl = unrealized_pnl(Side::Long, n, r_e, r_t).unwrap();
        assert_eq!(pnl, 45_454_540); // ≈ +$45.45
        // equity ≈ collateral + pnl = 100 + 45.45 = 145.45 USDC
        assert_eq!(equity(100_000_000, pnl, 0, 0), 145_454_540);
    }

    // §13.3 — Liquidation consistency: at R_liq, equity == MMR*N exactly; flips around it.
    #[test]
    fn liquidation_boundary() {
        let r_e = 50_000_000u128; // 0.05
        let leverage = 10u16;
        let mmr_bps = 500u16; // 5%
        let n = 1_000_000_000u64; // 1000 USDC
        let collateral = ((n as u128) * (BPS / leverage as u128) / BPS) as u64; // N * imr = N/leverage
        assert_eq!(collateral, 100_000_000); // 100 USDC

        // long
        let r_liq = liquidation_ratio(Side::Long, r_e, leverage, mmr_bps);
        assert_eq!(r_liq, 47_500_000); // 0.0475 = a 5% ratio drop
        let pnl = unrealized_pnl(Side::Long, n, r_e, r_liq).unwrap();
        let eq = equity(collateral, pnl, 0, 0);
        assert_eq!(eq, maintenance_margin(n, mmr_bps)); // equity == MMR*N exactly at R_liq
        assert!(!is_liquidatable(eq, n, mmr_bps)); // == is not yet liquidatable
        // one tick below R_liq → liquidatable
        let pnl_below = unrealized_pnl(Side::Long, n, r_e, r_liq - 100_000).unwrap();
        assert!(is_liquidatable(equity(collateral, pnl_below, 0, 0), n, mmr_bps));

        // short mirror: R_liq above entry
        let r_liq_s = liquidation_ratio(Side::Short, r_e, leverage, mmr_bps);
        assert_eq!(r_liq_s, 52_500_000);
        let pnl_s = unrealized_pnl(Side::Short, n, r_e, r_liq_s).unwrap();
        assert_eq!(equity(collateral, pnl_s, 0, 0), maintenance_margin(n, mmr_bps));
    }

    // §13.4 — funding: zero when index unchanged; sign per side; conservation of magnitude.
    #[test]
    fn funding_behaviour() {
        let n = 1_000_000_000u64;
        assert_eq!(funding_owed(Side::Long, n, 1_000, 1_000).unwrap(), 0);
        // cum rose (longs pay): long owes (+), short receives (−), equal magnitude
        let long = funding_owed(Side::Long, n, 5_000_000, 0).unwrap();
        let short = funding_owed(Side::Short, n, 5_000_000, 0).unwrap();
        assert!(long > 0 && short < 0);
        assert_eq!(long, -short);
        assert_eq!(long, (n as i128) * 5_000_000 / FUNDING_PRECISION); // = 5,000,000
    }

    // skew + funding_rate clamping.
    #[test]
    fn skew_and_funding_rate() {
        assert_eq!(skew(0, 0), 0);
        assert_eq!(skew(100, 100), 0);
        assert_eq!(skew(100, 0), FUNDING_PRECISION); // fully long → +1e9
        assert_eq!(skew(0, 100), -FUNDING_PRECISION);
        // k=1000bps(10%), f_max=5bps(0.05%). Full skew pre-clamp = 1e8, clamped to f_max=5e5.
        let f_max_1e9 = 5i128 * FUNDING_PRECISION / (BPS as i128); // 500_000
        assert_eq!(funding_rate(FUNDING_PRECISION, 1000, 5), f_max_1e9);
        assert_eq!(funding_rate(-FUNDING_PRECISION, 1000, 5), -f_max_1e9);
        assert_eq!(funding_rate(0, 1000, 5), 0);
        // accrual over 1s at 1h interval
        let cum = accrue_funding(0, f_max_1e9, 1, 3600).unwrap();
        assert_eq!(cum, f_max_1e9 / 3600);
    }

    // taker fee rounds UP (against the user), never to zero for nonzero notional + fee.
    #[test]
    fn fee_rounds_up() {
        assert_eq!(taker_fee(1_000_000_000, 6), 600_000); // 6bps of 1000 USDC = 0.6 USDC
        assert_eq!(taker_fee(1, 6), 1); // ceil(0.0006) = 1, never 0
        assert_eq!(taker_fee(0, 6), 0);
    }

    // §13.5 — LP share round-trip + first-deposit MIN_LIQUIDITY lock + dust rejection.
    #[test]
    fn lp_shares() {
        // first deposit 1000 USDC → shares = deposit − MIN_LIQUIDITY
        let d0 = 1_000_000_000u64;
        let s0 = shares_for_deposit(d0, 0, 0).unwrap();
        assert_eq!(s0, d0 as u128 - MIN_LIQUIDITY);
        assert!(matches!(shares_for_deposit(MIN_LIQUIDITY as u64, 0, 0), Err(MathError::DustDeposit)));

        // second LP deposits same amount into a pool with aum == d0 → ~proportional shares
        let total = s0;
        let s1 = shares_for_deposit(d0, total, d0).unwrap();
        // withdraw all of LP1's shares from aum that now includes both deposits
        let aum2 = 2 * d0;
        let total2 = total + s1;
        let out = usdc_for_shares(s1, total2, aum2).unwrap();
        // LP1 should get back ~their deposit (minus rounding); never more.
        assert!(out <= d0);
        assert!(out >= d0 - 10); // tight rounding tolerance
    }

    // net-OI utilization gate.
    #[test]
    fn net_util_gate() {
        // pool 1000 USDC, 50% util → net cap 500 USDC
        assert!(within_net_util(800_000_000, 400_000_000, 1_000_000_000, 5000)); // net 400 ≤ 500 ✓
        assert!(!within_net_util(900_000_000, 300_000_000, 1_000_000_000, 5000)); // net 600 > 500 ✗
        assert!(within_net_util(500_000_000, 500_000_000, 1_000_000_000, 5000)); // balanced ✓
    }

    // §13.7 — overflow safety: extreme notional × ratio swing returns Ok or a clean error, never panics.
    #[test]
    fn overflow_safety() {
        let n = u64::MAX;
        let r_e = 1u128;
        let r_t = RATIO_PRECISION * 1_000_000; // huge swing
        // i128 intermediate: n * (r_t - r_e) can overflow → must be Err, not panic
        let res = unrealized_pnl(Side::Long, n, r_e, r_t);
        assert!(res.is_ok() || res == Err(MathError::Overflow));
        // ratio with max prices
        assert!(compute_ratio(i64::MAX, 1).is_ok() || compute_ratio(i64::MAX, 1) == Err(MathError::Overflow));
        assert_eq!(compute_ratio(1, 0), Err(MathError::BadPrice));
        assert_eq!(compute_ratio(-1, 1), Err(MathError::BadPrice));
    }

    // §13.6 — determinism: identical inputs → identical outputs.
    #[test]
    fn determinism() {
        let a = unrealized_pnl(Side::Long, 123_456_789, 50_000_000, 52_272_727).unwrap();
        let b = unrealized_pnl(Side::Long, 123_456_789, 50_000_000, 52_272_727).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn primitive_error_paths() {
        assert_eq!(compute_ratio(1, 0), Err(MathError::BadPrice));
        assert_eq!(compute_ratio(0, 1), Err(MathError::BadPrice));
        assert_eq!(notional(u64::MAX, 2), Err(MathError::Overflow));
        assert_eq!(unrealized_pnl(Side::Long, 100, 0, 100), Err(MathError::DivByZero));
        assert_eq!(accrue_funding(0, 100, 1, 0), Err(MathError::DivByZero));
        // shares: aum==0 with shares outstanding -> DivByZero
        assert_eq!(shares_for_deposit(100, 1000, 0), Err(MathError::DivByZero));
        // subsequent deposit producing 0 shares -> DustDeposit
        assert_eq!(shares_for_deposit(1, 1000, 1_000_000_000), Err(MathError::DustDeposit));
        assert_eq!(usdc_for_shares(10, 0, 1000), Err(MathError::DivByZero));
        assert!(funding_owed(Side::Short, 1_000_000_000, 1_000_000, 0).unwrap() < 0);
        assert_eq!(Side::Long.sign(), 1);
        assert_eq!(Side::Short.sign(), -1);
    }

    #[test]
    fn amplify_ratio_behaviour() {
        let r0 = 50_000_000u128; // 0.05 anchor
        // identity cases pass raw straight through
        assert_eq!(amplify_ratio(50_500_000, r0, BPS as u32), 50_500_000); // 1x
        assert_eq!(amplify_ratio(50_500_000, r0, 0), 50_500_000); // amp 0 -> raw
        assert_eq!(amplify_ratio(50_500_000, 0, 100_000), 50_500_000); // no anchor -> raw
        // 10x amplification multiplies the deviation by 10
        // raw is +1% (500_000) above anchor -> amped is +10% (5_000_000) above anchor
        assert_eq!(amplify_ratio(50_500_000, r0, 100_000), 55_000_000);
        // and symmetric below the anchor
        assert_eq!(amplify_ratio(49_500_000, r0, 100_000), 45_000_000);
        // exactly at the anchor -> unchanged regardless of amp
        assert_eq!(amplify_ratio(r0, r0, 100_000), r0);
        // floor: an extreme amplified drop can never go non-positive
        assert!(amplify_ratio(1, r0, 1_000_000) >= 1);
    }

    #[test]
    fn accrue_funding_accumulates_over_time() {
        // exercise the non-clamped accrual path
        let c0 = accrue_funding(0, 360_000, 3600, 3600).unwrap(); // one full interval at rate 360_000
        assert_eq!(c0, 360_000);
        let c1 = accrue_funding(c0, 360_000, 1800, 3600).unwrap(); // half interval
        assert_eq!(c1, 360_000 + 180_000);
    }
}
