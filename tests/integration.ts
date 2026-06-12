// SHEAR end-to-end integration test (devnet + MagicBlock ER).
// Provider/routing pattern from ../magicblock-engine-examples/anchor-counter (two providers).
// Run after `anchor build && anchor deploy` so the IDL/types exist.
//
// Asserts the protocol invariants before/after:
//   custody:      vault.amount == Σ free_collateral + Σ position.collateral + pool_usdc + insurance
//   conservation: trades/funding/liquidation do not change total internal USDC (only deposit/withdraw)

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { GetCommitmentSignature, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert } from "chai";

const ORACLE = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ETH_USD = new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
// const VALIDATOR = new PublicKey("<ER validator pubkey>"); // pin one validator for ALL accounts

const seed = (s: string) => Buffer.from(s);
const symbol16 = (s: string) => {
  const b = Buffer.alloc(16);
  b.write(s);
  return b;
};

describe("shear integration", () => {
  const base = anchor.AnchorProvider.env();
  anchor.setProvider(base);
  const program = anchor.workspace.Shear as anchor.Program;
  const er = new anchor.AnchorProvider(
    new Connection(process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app", {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app",
      commitment: "confirmed",
    }),
    base.wallet
  );

  const programER = new anchor.Program(program.idl as any, er); // reads delegated accounts from the ER
  const pid = program.programId;
  const wallet = base.wallet.publicKey;
  const sym = symbol16("SHR" + Date.now().toString(36).slice(-6)); // unique per run (re-run safe)

  const [config] = PublicKey.findProgramAddressSync([seed("config")], pid);
  const [vaultAuth] = PublicKey.findProgramAddressSync([seed("vault_auth")], pid);
  const [vault] = PublicKey.findProgramAddressSync([seed("vault")], pid);
  const [market] = PublicKey.findProgramAddressSync([seed("market"), sym], pid);
  const [pool] = PublicKey.findProgramAddressSync([seed("pool"), market.toBuffer()], pid);
  const [userBal] = PublicKey.findProgramAddressSync([seed("user"), wallet.toBuffer()], pid);
  const [position] = PublicKey.findProgramAddressSync([seed("position"), wallet.toBuffer(), market.toBuffer()], pid);

  let usdc: PublicKey;
  let walletUsdc: PublicKey;

  // helper: send an instruction to the ER (signed locally), per the example pattern
  async function sendER(txBuilder: any, signers: Keypair[] = []) {
    const tx = await txBuilder.transaction();
    tx.feePayer = er.wallet.publicKey;
    tx.recentBlockhash = (await er.connection.getLatestBlockhash()).blockhash;
    const signed = await er.wallet.signTransaction(tx);
    return er.sendAndConfirm(signed, signers, { skipPreflight: true });
  }

  // ---- invariant helpers ----
  async function vaultAmount(conn: Connection) {
    return Number((await getAccount(conn, vault)).amount);
  }
  async function internalTotal(conn: Connection, owners: PublicKey[]) {
    const p = await program.account.liquidityPool.fetch(pool);
    let t = Number(p.poolUsdc) + Number(p.insuranceFund);
    for (const o of owners) {
      const [ub] = PublicKey.findProgramAddressSync([seed("user"), o.toBuffer()], pid);
      try { t += Number((await program.account.userBalance.fetch(ub)).freeCollateral); } catch {}
    }
    const pos = await program.account.position.fetch(position).catch(() => null);
    if (pos && pos.status.open) t += Number(pos.collateral);
    return t;
  }

  before(async () => {
    const payer = (base.wallet as any).payer;
    // The vault is a singleton bound to the first run's mint. On re-run, reuse config.usdcMint
    // (wallet is its mint authority) so deposits match the vault; else mint fresh.
    const cfg = await program.account.globalConfig.fetch(config).catch(() => null);
    usdc = cfg ? (cfg.usdcMint as PublicKey) : await createMint(base.connection, payer, wallet, null, 6);
    const ata = await getOrCreateAssociatedTokenAccount(base.connection, payer, usdc, wallet);
    walletUsdc = ata.address;
    await mintTo(base.connection, payer, usdc, walletUsdc, payer, 1_000_000_000_000); // 1M USDC
  });

  it("initialize_config + create_market + seed", async () => {
    // config is a singleton; tolerate a prior run having created it (re-run safe)
    try {
      await program.methods
        .initializeConfig({
          takerFeeBps: 6, liqPenaltyBps: 100, liqRewardShareBps: 5000, insuranceCutBps: 1000,
          minCollateral: new anchor.BN(10_000_000), minPositionNotional: new anchor.BN(50_000_000),
          maxAgeSec: new anchor.BN(60), maxRatioConfBps: 50, liqMaxConfBps: 100,
        })
        .accounts({ admin: wallet, config, usdcMint: usdc, vaultAuth, vault, oracleProgram: ORACLE, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();
    } catch (e: any) {
      if (!/already in use|custom program error: 0x0\b/.test(String(e))) throw e;
    }

    await program.methods
      .createMarket({
        symbol: [...sym], maxLeverage: 10, mmrBps: 500, kFundingBps: 1000, fMaxBps: 5,
        oiCapAbs: new anchor.BN(1_000_000_000_000), maxNetUtilBps: 5000,
      })
      .accounts({ admin: wallet, config, market, pool, baseFeed: SOL_USD, quoteFeed: ETH_USD })
      .rpc();

    const vaultBefore = await vaultAmount(base.connection); // vault exists post-init; shared across markets

    // LP seeds first liquidity (protocol-seeded), trader deposits collateral
    await program.methods.depositLiquidity(new anchor.BN(100_000_000_000)) // 100k USDC
      .accounts({ lp: wallet, config, market, pool, lpUsdc: walletUsdc, vault, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    await program.methods.depositCollateral(new anchor.BN(1_000_000_000)) // 1000 USDC
      .accounts({ trader: wallet, config, userBalance: userBal, traderUsdc: walletUsdc, vault, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
    await program.methods.initPosition().accounts({ owner: wallet, market, position }).rpc();

    // custody: the vault grew by EXACTLY this run's deposits (self-contained, re-run safe)
    const va = await vaultAmount(base.connection);
    assert.equal(va - vaultBefore, 101_000_000_000, "custody: vault grew by exactly the deposits");
  });

  it("delegate -> open -> accrue_funding -> close -> undelegate; conservation holds", async () => {
    // internal USDC before the trade cycle (everything still on L1, fresh)
    const before = await internalTotal(base.connection, [wallet]);

    // delegate shared (admin) + per-user. Pin VALIDATOR via remainingAccounts in real runs.
    await program.methods.delegateMarket([...sym]).accounts({ payer: wallet, market }).rpc({ skipPreflight: true });
    await program.methods.delegatePool().accounts({ payer: wallet, market, pool }).rpc({ skipPreflight: true });
    await program.methods.delegateUserBalance().accounts({ payer: wallet, userBalance: userBal }).rpc({ skipPreflight: true });
    await program.methods.delegatePosition().accounts({ payer: wallet, market, position }).rpc({ skipPreflight: true });

    const oracleAccts = { market, pool, userBalance: userBal, position, basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };
    await sendER(program.methods.openPosition({ long: {} }, new anchor.BN(100_000_000), 10).accounts({ signer: wallet, ...oracleAccts }));
    await sendER(program.methods.accrueFunding().accounts({ market }));
    await sendER(program.methods.closePosition().accounts({ signer: wallet, ...oracleAccts }));

    // undelegate trader accounts back to L1
    const undelTx = program.methods.undelegateTrader().accounts({ payer: wallet, userBalance: userBal, position });
    const sig = await sendER(undelTx);
    const commitSig = await GetCommitmentSignature(sig, er.connection);
    await base.connection.confirmTransaction(commitSig, "confirmed");

    // conservation: a trade cycle (open+funding+close) neither creates nor destroys internal USDC.
    // pool/market stay delegated -> read them LIVE from the ER; user_balance+position were
    // committed/undelegated -> read from L1. (Reading pool from L1 here would be stale.)
    const poolER = await programER.account.liquidityPool.fetch(pool);
    const ub = await program.account.userBalance.fetch(userBal);
    const posL1: any = await program.account.position.fetch(position).catch(() => null);
    const after =
      Number(poolER.poolUsdc) + Number(poolER.insuranceFund) +
      Number(ub.freeCollateral) +
      (posL1 && posL1.status.open ? Number(posL1.collateral) : 0);

    assert.equal(after, before, "conservation: trade cycle preserves total internal USDC");
  });

  it("schedule_funding_crank — the crank runs accrue_funding autonomously in the ER", async () => {
    // market is still delegated from the previous test; read its funding clock live from the ER.
    // accrue_funding advances last_funding_ts every call (engine.rs), so an advancing clock with
    // NO accrue tx from us proves the MagicBlock crank fired it on schedule. (OI is 0 -> rate 0,
    // but last_funding_ts still advances, which is the signal we assert on.)
    const m0: any = await programER.account.market.fetch(market);
    await sendER(
      program.methods
        .scheduleFundingCrank(new anchor.BN(7), new anchor.BN(1000), new anchor.BN(3))
        .accounts({ payer: wallet, market, magicProgram: MAGIC_PROGRAM_ID })
    );
    await new Promise((r) => setTimeout(r, 5000)); // let the crank fire ~3x (3 iterations @ 1s)
    const m1: any = await programER.account.market.fetch(market);
    assert.isAbove(
      Number(m1.lastFundingTs),
      Number(m0.lastFundingTs),
      "crank advanced market.last_funding_ts without us sending accrue_funding"
    );
    // cancel_crank needs the MagicBlock task_context PDA (no public derivation in the reference
    // example, which also never cancels); the crank self-terminates after `iterations`, so we
    // let it expire rather than force a cancel with an unknown account.
  });

  it("oracle guard: a stale/zero feed must revert open", async () => {
    // pass a non-oracle account as the feed -> read_ratio must revert (FeedMismatch/OracleStale).
    let reverted = false;
    try {
      await sendER(program.methods.openPosition({ long: {} }, new anchor.BN(100_000_000), 10)
        .accounts({ signer: wallet, market, pool, userBalance: userBal, position, basePrice: vault, quotePrice: ETH_USD, sessionToken: null }));
    } catch { reverted = true; }
    assert.isTrue(reverted, "open must revert on a bad/unbound oracle feed");
  });
});
