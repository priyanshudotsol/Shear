// Shared helpers for the SHEAR devnet test scripts (current program: 6MmN…, _uc seeds).
//
// Money model (post-shuttle): real USDC lives only in the vault. deposit_collateral STAGES into the
// per-trader CollateralShuttle; claim_deposit folds it into free_collateral on the ER. Withdrawals go
// request_withdraw (ER) -> undelegate_shuttle -> settle_withdraw (L1). The trading unit (UserBalance +
// PositionBook) never has to undelegate to move collateral.
//
// The protocol is bound to Circle's devnet USDC, which the program CANNOT faucet (the vault is not the
// mint authority). So these scripts fund a fresh test wallet by transferring real USDC out of the
// admin (devnet-trading-wallet) ATA — the admin must hold enough Circle USDC + SOL to run a script.
const fs = require("fs"), path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require("../frontend/node_modules/@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, TOKEN_PROGRAM_ID } = require("../frontend/node_modules/@solana/spl-token");
const idl = require("../frontend/src/lib/idl/shear.json");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // Circle devnet USDC (live config.usdc_mint)
const SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ETH_USD = new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
const { BASE_RPC, ER_RPC } = require("./_env.cjs");
const base = new Connection(BASE_RPC, "confirmed");
const er = new Connection(ER_RPC, "confirmed");
const SYMBOL = "SOL-ETH";
const BN = anchor.BN;
// The ONE ER validator everything is delegated to (co-delegation rule). Must match the validator the
// shared market/pool are pinned to and the identity behind the ER endpoint (devnet.magicblock.app).
const ER_VALIDATOR = new PublicKey(process.env.ER_VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const VR = [{ pubkey: ER_VALIDATOR, isWritable: false, isSigner: false }]; // validator as first remaining account

const enc = (s) => new TextEncoder().encode(s);
const sym16 = () => { const b = Buffer.alloc(16); b.write(SYMBOL); return b; };
const usdc = (x) => new BN(Math.round(x * 1e6));

// v2 (_uc) PDA seeds — must match programs/shear/src/constants.rs.
const pda = {
  config: () => PublicKey.findProgramAddressSync([enc("config_uc")], PID)[0],
  market: () => PublicKey.findProgramAddressSync([enc("market_uc"), sym16()], PID)[0],
  pool: (m) => PublicKey.findProgramAddressSync([enc("pool_uc"), m.toBuffer()], PID)[0],
  user: (o) => PublicKey.findProgramAddressSync([enc("user_uc"), o.toBuffer()], PID)[0],
  position: (o, m) => PublicKey.findProgramAddressSync([enc("posbook_uc"), o.toBuffer(), m.toBuffer()], PID)[0],
  shuttle: (o) => PublicKey.findProgramAddressSync([enc("shuttle_uc"), o.toBuffer()], PID)[0],
  vault: () => PublicKey.findProgramAddressSync([enc("vault_uc")], PID)[0],
};

const loadAdmin = () =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
const wallet = (kp) => ({
  publicKey: kp.publicKey,
  signTransaction: async (t) => (t.partialSign(kp), t),
  signAllTransactions: async (ts) => ts.map((t) => (t.partialSign(kp), t)),
});
const prog = (conn, w) => new anchor.Program(idl, new anchor.AnchorProvider(conn, w, {}));

async function send(conn, kp, ixs, label, tolerate) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await conn.confirmTransaction(sig, "confirmed");
  if (r.value.err) {
    if (tolerate) { console.log(`   ${label} REVERTED (expected):`, JSON.stringify(r.value.err)); return false; }
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    throw new Error(`${label}: ` + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).slice(-6).join("\n"));
  }
  console.log(`   ${label} OK`);
  return true;
}

const onER = async (k) => { const i = await er.getAccountInfo(k); return !!i && i.data.length > 0; };
const waitER = async (ks) => { for (let i = 0; i < 25; i++) { if ((await Promise.all(ks.map(onER))).every(Boolean)) return; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("ER not ready"); };
const settled = async (k) => { for (let i = 0; i < 25; i++) { const b = await base.getAccountInfo(k); if (b && b.owner.equals(PID)) return; await new Promise((r) => setTimeout(r, 1500)); } };
const isDelegated = async (k) => { const i = await base.getAccountInfo(k); return !!i && !i.owner.equals(PID); };

// Read free_collateral (USDC) from whichever layer currently owns UserBalance.
async function freeCollateral(owner) {
  const ub = pda.user(owner);
  const conn = (await isDelegated(ub)) ? er : base;
  const p = prog(conn, wallet(Keypair.generate()));
  try { const u = await p.account.userBalance.fetch(ub); return Number(u.freeCollateral) / 1e6; } catch { return 0; }
}

// Fund a fresh owner + session keypair with SOL, and the owner's ATA with real Circle USDC from admin.
async function fundOwner(admin, owner, session, { solOwner = 0.05, solSession = 0.04, usdc: usdcAmt = 6 } = {}) {
  await send(base, admin, [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: solOwner * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: session.publicKey, lamports: solSession * LAMPORTS_PER_SOL }),
  ], "fund SOL");
  const adminAta = getAssociatedTokenAddressSync(MINT, admin.publicKey);
  const ownerAta = getAssociatedTokenAddressSync(MINT, owner.publicKey);
  await send(base, admin, [
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ownerAta, owner.publicKey, MINT),
    createTransferInstruction(adminAta, ownerAta, admin.publicKey, Math.round(usdcAmt * 1e6)),
  ], `fund ${usdcAmt} USDC`);
  return ownerAta;
}

// Ensure the shared market + pool are delegated to the ER (permissionless; owner-signed).
async function ensureMarketDelegated(owner) {
  const p = prog(base, wallet(owner)), m = pda.market(), pool = pda.pool(m);
  if (!(await isDelegated(m))) await send(base, owner, [await p.methods.delegateMarket([...sym16()]).accounts({ payer: owner.publicKey, market: m }).remainingAccounts(VR).instruction()], "delegate market");
  if (!(await isDelegated(pool))) await send(base, owner, [await p.methods.delegatePool().accounts({ payer: owner.publicKey, market: m, pool }).remainingAccounts(VR).instruction()], "delegate pool");
}

// Shuttle IN: claim a deposit staged on L1 (shuttle.deposit_amt) into free_collateral on the ER.
async function claimStaged(owner, session) {
  const ub = pda.user(owner.publicKey), sh = pda.shuttle(owner.publicKey);
  if (!(await isDelegated(sh))) await send(base, owner, [await prog(base, wallet(owner)).methods.delegateShuttle().accounts({ payer: owner.publicKey, shuttle: sh }).remainingAccounts(VR).instruction()], "delegate shuttle (in)");
  await waitER([sh, ub]);
  const erp = prog(er, wallet(session));
  await send(er, session, [await erp.methods.claimDeposit().accounts({ signer: session.publicKey, userBalance: ub, shuttle: sh }).instruction()], "claim_deposit");
  await send(er, session, [await erp.methods.undelegateShuttle().accounts({ payer: session.publicKey, shuttle: sh }).instruction()], "undelegate_shuttle (in)");
  await settled(sh);
}

// Shuttle OUT: debit free_collateral on the ER (request_withdraw) and pay it out on L1 (settle_withdraw).
async function withdrawShuttle(owner, session, amount, ownerAta) {
  const ub = pda.user(owner.publicKey), sh = pda.shuttle(owner.publicKey);
  if (!(await isDelegated(sh))) await send(base, owner, [await prog(base, wallet(owner)).methods.delegateShuttle().accounts({ payer: owner.publicKey, shuttle: sh }).remainingAccounts(VR).instruction()], "delegate shuttle (out)");
  await waitER([sh, ub]);
  const erp = prog(er, wallet(session));
  await send(er, session, [await erp.methods.requestWithdraw(usdc(amount)).accounts({ signer: session.publicKey, userBalance: ub, shuttle: sh }).instruction()], "request_withdraw");
  await send(er, session, [await erp.methods.undelegateShuttle().accounts({ payer: session.publicKey, shuttle: sh }).instruction()], "undelegate_shuttle (out)");
  await settled(sh);
  await send(base, owner, [await prog(base, wallet(owner)).methods.settleWithdraw().accounts({ trader: owner.publicKey, traderUsdc: ownerAta, tokenProgram: TOKEN_PROGRAM_ID }).instruction()], "settle_withdraw");
}

// One-shot: init + stage deposit + init position + session key, then delegate the trading unit and
// credit the deposit onto the ER. Leaves the trader ready to open on `market`.
async function provision(owner, session, ownerAta, depositUsdc) {
  const m = pda.market(), ub = pda.user(owner.publicKey), book = pda.position(owner.publicKey, m);
  const p = prog(base, wallet(owner));
  await send(base, owner, [
    await p.methods.initUserBalance().accounts({ trader: owner.publicKey }).instruction(),
    await p.methods.depositCollateral(usdc(depositUsdc)).accounts({ trader: owner.publicKey, traderUsdc: ownerAta, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await p.methods.initPosition().accounts({ owner: owner.publicKey, market: m, position: book }).instruction(),
    await p.methods.setSessionKey(session.publicKey).accounts({ owner: owner.publicKey, userBalance: ub }).instruction(),
  ], `init + stage ${depositUsdc} USDC + session key`);
  await send(base, owner, [await p.methods.delegateUserBalance().accounts({ payer: owner.publicKey, userBalance: ub }).remainingAccounts(VR).instruction()], "delegate balance");
  await send(base, owner, [await p.methods.delegatePosition().accounts({ payer: owner.publicKey, market: m, position: book }).remainingAccounts(VR).instruction()], "delegate position");
  await ensureMarketDelegated(owner);
  await claimStaged(owner, session);
  await waitER([m, pda.pool(m), ub, book]);
}

const erAccounts = (session, owner) => {
  const m = pda.market();
  return { signer: session.publicKey, market: m, pool: pda.pool(m), userBalance: pda.user(owner.publicKey), positionBook: pda.position(owner.publicKey, m), basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };
};

module.exports = {
  anchor, BN, usdc, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  PID, MINT, SOL_USD, ETH_USD, base, er, SYMBOL, sym16, pda,
  loadAdmin, wallet, prog, send, onER, waitER, settled, isDelegated, freeCollateral,
  fundOwner, ensureMarketDelegated, claimStaged, withdrawShuttle, provision, erAccounts,
};
