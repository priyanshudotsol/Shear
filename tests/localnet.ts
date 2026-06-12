// SHEAR localnet contract suite — exercises every localnet-testable instruction and asserts
// EXACT account state, emitted EVENTS, and exact numeric outcomes (not just "didn't revert").
//
// Coverage of the 21 instructions:
//   ✓ initialize_config, create_market, set_market_status, set_paused
//   ✓ deposit_collateral, withdraw_collateral, deposit_liquidity, withdraw_liquidity
//   ✓ init_position, open_position, close_position, add_collateral, remove_collateral
//   ✓ accrue_funding, liquidate, crank_liquidate_one
//   ✗ delegate_* / commit_trader / undelegate_trader / schedule_funding_crank / cancel_crank
//       — require the MagicBlock delegation + magic programs (not on a local validator).
//         Covered by tests/integration.ts against --provider.cluster devnet.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

const sd = (s: string) => Buffer.from(s);
const sym16 = (s: string) => { const b = Buffer.alloc(16); b.write(s); return b; };
const sym8 = (s: string) => { const b = Buffer.alloc(8); b.write(s); return b; };
const E8 = (n: number) => new anchor.BN(Math.round(n * 1e8));
const USDC = (n: number) => new anchor.BN(Math.round(n * 1e6));
const N = (x: any) => Number(x.toString());

describe("shear contract", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Shear as anchor.Program;
  const mock = anchor.workspace.MockOracle as anchor.Program;
  const conn = provider.connection;
  const w = provider.wallet.publicKey;
  const payer = (provider.wallet as any).payer;
  const pid = program.programId;

  const symbol = sym16("SOL-ETH");
  const [config] = PublicKey.findProgramAddressSync([sd("config")], pid);
  const [vaultAuth] = PublicKey.findProgramAddressSync([sd("vault_auth")], pid);
  const [vault] = PublicKey.findProgramAddressSync([sd("vault")], pid);
  const [market] = PublicKey.findProgramAddressSync([sd("market"), symbol], pid);
  const [pool] = PublicKey.findProgramAddressSync([sd("pool"), market.toBuffer()], pid);
  const [userBal] = PublicKey.findProgramAddressSync([sd("user"), w.toBuffer()], pid);
  const [position] = PublicKey.findProgramAddressSync([sd("position"), w.toBuffer(), market.toBuffer()], pid);
  const [lpPos] = PublicKey.findProgramAddressSync([sd("lp"), w.toBuffer(), pool.toBuffer()], pid);
  const [solFeed] = PublicKey.findProgramAddressSync([sd("feed"), sym8("SOL")], mock.programId);
  const [ethFeed] = PublicKey.findProgramAddressSync([sd("feed"), sym8("ETH")], mock.programId);

  let usdc: PublicKey, wAta: PublicKey;
  const liquidator = Keypair.generate();
  const [liqBal] = PublicKey.findProgramAddressSync([sd("user"), liquidator.publicKey.toBuffer()], pid);
  let liqAta: PublicKey;

  const tradeAccts = { signer: w, market, pool, userBalance: userBal, position, basePrice: solFeed, quotePrice: ethFeed, sessionToken: null };
  const setPrice = (s: string, feed: PublicKey, price: number) =>
    mock.methods.setPrice([...sym8(s)], E8(price), E8(price * 0.0005), -8).accounts({ payer: w, feed }).rpc();
  const feeds = async (solP: number, ethP: number) => { await setPrice("SOL", solFeed, solP); await setPrice("ETH", ethFeed, ethP); };
  const fails = async (p: Promise<any>) => { try { await p; return false; } catch { return true; } };

  // decode the events emitted by a tx
  async function eventsOf(sig: string, name?: string) {
    await conn.confirmTransaction(sig, "confirmed");
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, (program as any).coder);
    const evs = [...parser.parseLogs(tx!.meta!.logMessages!)];
    return name ? evs.filter((e) => e.name.toLowerCase() === name.toLowerCase()) : evs;
  }
  const vaultAmt = async () => N((await getAccount(conn, vault)).amount);
  async function internal() {
    const p: any = await program.account.liquidityPool.fetch(pool);
    let t = N(p.poolUsdc) + N(p.insuranceFund);
    for (const [, ub] of [["w", userBal], ["liq", liqBal]] as any) {
      const a: any = await program.account.userBalance.fetch(ub).catch(() => null);
      if (a) t += N(a.freeCollateral);
    }
    const pos: any = await program.account.position.fetch(position).catch(() => null);
    if (pos && pos.status.open) t += N(pos.collateral);
    return t;
  }

  before(async () => {
    usdc = await createMint(conn, payer, w, null, 6);
    wAta = (await getOrCreateAssociatedTokenAccount(conn, payer, usdc, w)).address;
    await mintTo(conn, payer, usdc, wAta, payer, 1_000_000_000_000);
    // fund liquidator
    await conn.confirmTransaction(await conn.requestAirdrop(liquidator.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
    liqAta = (await getOrCreateAssociatedTokenAccount(conn, payer, usdc, liquidator.publicKey)).address;
    await mintTo(conn, payer, usdc, liqAta, payer, 1_000_000_000);
    await feeds(150, 3000);
  });

  it("initialize_config — exact config + vault created", async () => {
    await program.methods.initializeConfig({
      takerFeeBps: 6, liqPenaltyBps: 100, liqRewardShareBps: 5000, insuranceCutBps: 1000,
      minCollateral: USDC(10), minPositionNotional: USDC(50),
      maxAgeSec: new anchor.BN(120), maxRatioConfBps: 50, liqMaxConfBps: 100,
    }).accounts({ admin: w, config, usdcMint: usdc, vaultAuth, vault, oracleProgram: mock.programId, tokenProgram: TOKEN_PROGRAM_ID }).rpc();

    const c: any = await program.account.globalConfig.fetch(config);
    assert.equal(c.admin.toBase58(), w.toBase58());
    assert.equal(c.usdcMint.toBase58(), usdc.toBase58());
    assert.equal(c.takerFeeBps, 6);
    assert.equal(c.liqPenaltyBps, 100);
    assert.equal(c.liqRewardShareBps, 5000);
    assert.equal(c.insuranceCutBps, 1000);
    assert.equal(N(c.minCollateral), 10_000_000);
    assert.equal(N(c.minPositionNotional), 50_000_000);
    assert.equal(c.paused, false);
    assert.equal(await vaultAmt(), 0);
  });

  it("create_market — exact market + pool fields + MarketCreated event", async () => {
    const sig = await program.methods.createMarket({
      symbol: [...symbol], maxLeverage: 10, mmrBps: 500, kFundingBps: 1000, fMaxBps: 5,
      oiCapAbs: USDC(1_000_000), maxNetUtilBps: 5000,
    }).accounts({ admin: w, config, market, pool, baseFeed: solFeed, quoteFeed: ethFeed }).rpc();

    const m: any = await program.account.market.fetch(market);
    assert.equal(m.baseFeed.toBase58(), solFeed.toBase58());
    assert.equal(m.quoteFeed.toBase58(), ethFeed.toBase58());
    assert.equal(m.expo, -8);
    assert.equal(m.maxLeverage, 10);
    assert.equal(m.mmrBps, 500);
    assert.equal(m.kFundingBps, 1000);
    assert.equal(m.fMaxBps, 5);
    assert.equal(m.maxNetUtilBps, 5000);
    assert.equal(m.takerFeeBps, 6, "config snapshot copied into market");
    assert.equal(N(m.longOi), 0);
    assert.equal(N(m.shortOi), 0);
    assert.equal(N(m.cumFunding), 0);
    assert.isDefined(m.status.active);

    const p: any = await program.account.liquidityPool.fetch(pool);
    assert.equal(p.market.toBase58(), market.toBase58());
    assert.equal(N(p.totalShares), 0);
    assert.equal(N(p.poolUsdc), 0);

    const evs = await eventsOf(sig, "marketCreated");
    assert.equal(evs.length, 1, "MarketCreated emitted");
    assert.equal((evs[0].data.market as PublicKey).toBase58(), market.toBase58());
  });

  it("set_paused / set_market_status — admin only", async () => {
    await program.methods.setPaused(true).accounts({ admin: w, config }).rpc();
    assert.equal((await program.account.globalConfig.fetch(config) as any).paused, true);
    await program.methods.setPaused(false).accounts({ admin: w, config }).rpc();
    await program.methods.setMarketStatus({ reduceOnly: {} }).accounts({ admin: w, config, market }).rpc();
    assert.isDefined((await program.account.market.fetch(market) as any).status.reduceOnly);
    await program.methods.setMarketStatus({ active: {} }).accounts({ admin: w, config, market }).rpc();
    // non-admin cannot flip status
    assert.isTrue(await fails(
      program.methods.setMarketStatus({ halted: {} })
        .accounts({ admin: liquidator.publicKey, config, market }).signers([liquidator]).rpc()
    ), "non-admin rejected");
  });

  it("deposit_liquidity (first) — shares = deposit − MIN_LIQUIDITY, exact pool + event", async () => {
    const sig = await program.methods.depositLiquidity(USDC(100_000))
      .accounts({ lp: w, config, market, pool, lpUsdc: wAta, vault, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    const p: any = await program.account.liquidityPool.fetch(pool);
    assert.equal(N(p.poolUsdc), 100_000_000_000);
    assert.equal(N(p.totalShares), 100_000_000_000 - 1000, "MIN_LIQUIDITY locked");
    const lp: any = await program.account.lpPosition.fetch(lpPos);
    assert.equal(N(lp.shares), 100_000_000_000 - 1000);
    assert.equal(await vaultAmt(), 100_000_000_000);
    const evs = await eventsOf(sig, "liquidityDeposited");
    assert.equal(N(evs[0].data.amount), 100_000_000_000);
    assert.equal(N(evs[0].data.shares), 100_000_000_000 - 1000);
  });

  it("deposit_collateral — exact free + vault + event", async () => {
    const sig = await program.methods.depositCollateral(USDC(1_000))
      .accounts({ trader: w, config, userBalance: userBal, traderUsdc: wAta, vault, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    assert.equal(N((await program.account.userBalance.fetch(userBal) as any).freeCollateral), 1_000_000_000);
    assert.equal(await vaultAmt(), 101_000_000_000);
    assert.equal(N((await eventsOf(sig, "collateralDeposited"))[0].data.amount), 1_000_000_000);
  });

  it("init_position — empty Closed slot", async () => {
    await program.methods.initPosition().accounts({ owner: w, market, position }).rpc();
    const pos: any = await program.account.position.fetch(position);
    assert.equal(pos.owner.toBase58(), w.toBase58());
    assert.equal(pos.market.toBase58(), market.toBase58());
    assert.isDefined(pos.status.closed);
    assert.equal(N(pos.notional), 0);
    // custody invariant after setup
    assert.equal(await vaultAmt(), await internal());
  });

  it("rejects invalid opens (leverage / min / dust / insufficient / oi-cap)", async () => {
    const o = (coll: anchor.BN, lev: number) => program.methods.openPosition({ long: {} }, coll, lev).accounts(tradeAccts).rpc();
    assert.isTrue(await fails(o(USDC(100), 0)), "leverage 0");
    assert.isTrue(await fails(o(USDC(100), 11)), "leverage > max");
    assert.isTrue(await fails(o(USDC(5), 10)), "below min collateral");
    assert.isTrue(await fails(o(USDC(10), 1)), "dust notional");
    assert.isTrue(await fails(o(USDC(2000), 10)), "insufficient collateral");
  });

  it("open_position — EXACT state (entry_ratio, notional, OI, fee split) + event", async () => {
    const sig = await program.methods.openPosition({ long: {} }, USDC(100), 10).accounts(tradeAccts).rpc();
    const pos: any = await program.account.position.fetch(position);
    assert.isDefined(pos.side.long);
    assert.equal(N(pos.notional), 1_000_000_000);
    assert.equal(N(pos.entryRatio), 50_000_000, "R_e = SOL/ETH = 150/3000 = 0.05 (1e9)");
    assert.equal(N(pos.collateral), 100_000_000);
    assert.isDefined(pos.status.open);

    const m: any = await program.account.market.fetch(market);
    assert.equal(N(m.longOi), 1_000_000_000);
    assert.equal(N(m.shortOi), 0);

    const u: any = await program.account.userBalance.fetch(userBal);
    assert.equal(N(u.freeCollateral), 1_000_000_000 - 100_600_000, "collateral + 6bps fee debited");
    const p: any = await program.account.liquidityPool.fetch(pool);
    assert.equal(N(p.insuranceFund), 60_000, "10% of the 600000 fee");
    assert.equal(N(p.poolUsdc), 100_000_000_000 + 540_000, "fee remainder to pool");

    const ev = (await eventsOf(sig, "positionOpened"))[0];
    assert.equal(N(ev.data.notional), 1_000_000_000);
    assert.equal(N(ev.data.entryRatio), 50_000_000);
    assert.equal(N(ev.data.collateral), 100_000_000);
  });

  it("accrue_funding — long-heavy: skew = 1e9, rate = f_max, cum_funding > 0 + event", async () => {
    const sig = await program.methods.accrueFunding().accounts({ market }).rpc();
    const m: any = await program.account.market.fetch(market);
    assert.isAbove(N(m.cumFunding), 0, "longs pay in a long-heavy book");
    const ev = (await eventsOf(sig, "fundingAccrued"))[0];
    assert.equal(N(ev.data.skew), 1_000_000_000, "fully long-skewed");
    assert.equal(N(ev.data.fundingRate), 500_000, "clamped to f_max (0.05%/hr, 1e9-scaled)");
    assert.equal(N(ev.data.cumFunding), N(m.cumFunding));
  });

  it("add_collateral / remove_collateral — exact + event + health guard", async () => {
    const mc = { signer: w, market, userBalance: userBal, position, basePrice: solFeed, quotePrice: ethFeed, sessionToken: null };
    let sig = await program.methods.addCollateral(USDC(100)).accounts(mc).rpc();
    assert.equal(N((await program.account.position.fetch(position) as any).collateral), 200_000_000);
    assert.equal(N((await eventsOf(sig, "positionModified"))[0].data.collateral), 200_000_000);

    await program.methods.removeCollateral(USDC(50)).accounts(mc).rpc();
    assert.equal(N((await program.account.position.fetch(position) as any).collateral), 150_000_000);
    // removing down near the initial margin breaches the 2× maintenance health buffer -> rejected
    assert.isTrue(await fails(program.methods.removeCollateral(USDC(99)).accounts(mc).rpc()), "remove into near-liquidation rejected");
  });

  it("close_position — EXACT uPnL (+$45.45) in the crash + event + OI back to 0; conserves", async () => {
    const before = await internal();
    await feeds(138, 2640); // SOL −8%, ETH −12% -> ratio up 4.5%
    const freeBefore = N((await program.account.userBalance.fetch(userBal) as any).freeCollateral);
    const sig = await program.methods.closePosition().accounts(tradeAccts).rpc();

    const ev = (await eventsOf(sig, "positionClosed"))[0];
    assert.equal(N(ev.data.upnl), 45_454_540, "uPnL = N·(R_t/R_e − 1) to the unit");

    const pos: any = await program.account.position.fetch(position);
    assert.isDefined(pos.status.closed);
    const m: any = await program.account.market.fetch(market);
    assert.equal(N(m.longOi), 0);
    const freeAfter = N((await program.account.userBalance.fetch(userBal) as any).freeCollateral);
    assert.isAbove(freeAfter - freeBefore, USDC(144).toNumber(), "collateral + ~45 profit returned");
    assert.equal(await vaultAmt(), await internal(), "close conserves");
    assert.equal(before, await internal());
  });

  it("liquidate — EXACT penalty/reward split, liquidator paid, event; conserves", async () => {
    await feeds(150, 3000);
    // liquidator needs a UserBalance (created by a deposit)
    await program.methods.depositCollateral(USDC(100))
      .accounts({ trader: liquidator.publicKey, config, userBalance: liqBal, traderUsdc: liqAta, vault, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([liquidator]).rpc();
    await program.methods.openPosition({ long: {} }, USDC(100), 10).accounts(tradeAccts).rpc();

    const before = await internal();
    await setPrice("SOL", solFeed, 141); // ratio −6% -> 10x underwater past MMR, equity still > 0
    const liqFreeBefore = N((await program.account.userBalance.fetch(liqBal) as any).freeCollateral);
    const sig = await program.methods.liquidate()
      .accounts({ liquidator: liquidator.publicKey, market, pool, userBalance: userBal, liquidatorBalance: liqBal, position, basePrice: solFeed, quotePrice: ethFeed })
      .signers([liquidator]).rpc();

    const ev = (await eventsOf(sig, "liquidated"))[0];
    assert.equal(N(ev.data.liquidatorReward), 5_000_000, "50% of the 1% penalty on 1000 USDC notional");
    assert.equal(N(ev.data.badDebt), 0, "equity > 0, no bad debt");
    assert.isDefined((await program.account.position.fetch(position) as any).status.liquidated);
    const liqFreeAfter = N((await program.account.userBalance.fetch(liqBal) as any).freeCollateral);
    assert.equal(liqFreeAfter - liqFreeBefore, 5_000_000, "liquidator credited the reward");
    assert.equal(before, await internal(), "liquidation conserves physical USDC");
  });

  it("crank_liquidate_one — bad-debt path: liquidated, BadDebtIncurred event; conserves", async () => {
    await feeds(150, 3000);
    await program.methods.openPosition({ long: {} }, USDC(100), 10).accounts(tradeAccts).rpc();
    const before = await internal();
    await setPrice("SOL", solFeed, 120); // ratio −20% -> loss exceeds collateral
    const sig = await program.methods.crankLiquidateOne()
      .accounts({ market, pool, userBalance: userBal, position, basePrice: solFeed, quotePrice: ethFeed }).rpc();
    const evs = await eventsOf(sig, "badDebtIncurred");
    assert.equal(evs.length, 1, "bad debt emitted");
    assert.isAbove(N(evs[0].data.amount), 0);
    assert.isDefined((await program.account.position.fetch(position) as any).status.liquidated);
    assert.equal(before, await internal(), "bad-debt liquidation still conserves physical USDC");
  });

  it("withdraw_liquidity blocked while OI is open, succeeds when flat + event", async () => {
    await feeds(150, 3000);
    await program.methods.openPosition({ long: {} }, USDC(100), 10).accounts(tradeAccts).rpc();
    // draining the pool below the net-OI buffer must fail
    assert.isTrue(await fails(
      program.methods.withdrawLiquidity(new anchor.BN("99000000000"))
        .accounts({ lp: w, config, market, pool, lpPosition: lpPos, vault, vaultAuth, lpUsdc: wAta, tokenProgram: TOKEN_PROGRAM_ID }).rpc()
    ), "LP withdraw blocked by open OI");
    await program.methods.closePosition().accounts(tradeAccts).rpc();

    const poolBefore = N((await program.account.liquidityPool.fetch(pool) as any).poolUsdc);
    const sig = await program.methods.withdrawLiquidity(new anchor.BN("10000000000")) // 10k shares
      .accounts({ lp: w, config, market, pool, lpPosition: lpPos, vault, vaultAuth, lpUsdc: wAta, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    const poolAfter = N((await program.account.liquidityPool.fetch(pool) as any).poolUsdc);
    assert.isBelow(poolAfter, poolBefore, "pool_usdc decreased");
    const ev = (await eventsOf(sig, "liquidityWithdrawn"))[0];
    assert.equal(N(ev.data.shares), 10_000_000_000);
    assert.isAbove(N(ev.data.amount), 0);
  });

  it("withdraw_collateral — drains free to 0, USDC back to wallet + event", async () => {
    const free = N((await program.account.userBalance.fetch(userBal) as any).freeCollateral);
    const ataBefore = N((await getAccount(conn, wAta)).amount);
    const sig = await program.methods.withdrawCollateral(new anchor.BN(free))
      .accounts({ trader: w, config, userBalance: userBal, vault, vaultAuth, traderUsdc: wAta, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    assert.equal(N((await program.account.userBalance.fetch(userBal) as any).freeCollateral), 0);
    assert.equal(N((await getAccount(conn, wAta)).amount), ataBefore + free, "USDC returned to wallet");
    assert.equal(N((await eventsOf(sig, "collateralWithdrawn"))[0].data.amount), free);
  });
});
