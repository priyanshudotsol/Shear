// Reproduce the user's case: delegated user_balance with too little collateral, then top it up via
// undelegate_user -> deposit -> re-delegate -> open. Run: node scripts/test-topup.cjs
const fs = require("fs"), path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require("../frontend/node_modules/@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } = require("../frontend/node_modules/@solana/spl-token");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const MINT = new PublicKey("CU4JxjFB16HLz5mfppgdGfHpbS7gde5SLsxRSXLh7KU6");
const SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ETH_USD = new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
const idl = require("../frontend/src/lib/idl/shear.json");
const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market"), sym], PID);
const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), market.toBuffer()], PID);
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const er = new Connection("https://devnet.magicblock.app", "confirmed");

async function send(conn, kp, ixs, label, tolerate) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await conn.confirmTransaction(sig, "confirmed");
  if (r.value.err) { if (tolerate) { console.log(`   ${label} REVERTED (expected):`, JSON.stringify(r.value.err)); return false; } const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); throw new Error(`${label}: ` + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).slice(-5).join("\n")); }
  console.log(`   ${label} OK`); return true;
}
const onER = async k => { const i = await er.getAccountInfo(k); return !!i && i.data.length > 0; };
const waitER = async ks => { for (let i=0;i<25;i++){ if ((await Promise.all(ks.map(onER))).every(Boolean)) return; await new Promise(r=>setTimeout(r,1000)); } throw new Error("ER not ready"); };
const settled = async k => { for (let i=0;i<25;i++){ const b=await base.getAccountInfo(k); if (b && b.owner.equals(PID)) return; await new Promise(r=>setTimeout(r,1500)); } };

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const owner = Keypair.generate(), sk = Keypair.generate();
  console.log("owner:", owner.publicKey.toBase58());
  await send(base, admin, [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sk.publicKey, lamports: 0.06 * LAMPORTS_PER_SOL }),
  ], "fund");
  const w = { publicKey: owner.publicKey, signTransaction: async t => (t.partialSign(owner), t) };
  const prog = new anchor.Program(idl, new anchor.AnchorProvider(base, w, {}));
  const erp = new anchor.Program(idl, new anchor.AnchorProvider(er, w, {}));
  const [ub] = PublicKey.findProgramAddressSync([Buffer.from("user"), owner.publicKey.toBuffer()], PID);
  const [book] = PublicKey.findProgramAddressSync([Buffer.from("posbook"), owner.publicKey.toBuffer(), market.toBuffer()], PID);
  const ata = getAssociatedTokenAddressSync(MINT, owner.publicKey);
  const erAcc = { signer: sk.publicKey, market, pool, userBalance: ub, positionBook: book, basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };

  // setup with a SMALL deposit (50 USDC) then delegate — too little for a 100-collateral position
  await send(base, owner, [
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, MINT),
    await prog.methods.faucet().accounts({ recipient: owner.publicKey, usdcMint: MINT, recipientUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.depositCollateral(new anchor.BN(50_000_000)).accounts({ trader: owner.publicKey, traderUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.initPosition().accounts({ owner: owner.publicKey, market, positionBook: book }).instruction(),
    await prog.methods.setSessionKey(sk.publicKey).accounts({ owner: owner.publicKey, userBalance: ub }).instruction(),
  ], "deposit 50 + init + session key");
  await send(base, owner, [await prog.methods.delegateUserBalance().accounts({ payer: owner.publicKey, userBalance: ub }).instruction()], "delegate user_balance");
  await send(base, owner, [await prog.methods.delegatePosition().accounts({ payer: owner.publicKey, market, position: book }).instruction()], "delegate book");
  await waitER([market, pool, ub, book]);

  // try to open a 100-collateral position -> should REVERT (insufficient collateral)
  const opened = await send(er, sk, [await erp.methods.openPosition(0, { long: {} }, new anchor.BN(100_000_000), 5).accounts(erAcc).instruction()], "open 100 (too little)", true);
  if (opened) throw new Error("expected insufficient-collateral revert");

  // TOP UP: undelegate user_balance -> deposit 100 more -> re-delegate -> open
  await send(er, sk, [await erp.methods.undelegateUser().accounts({ payer: sk.publicKey, userBalance: ub }).instruction()], "undelegate_user");
  await settled(ub);
  await send(base, owner, [await prog.methods.depositCollateral(new anchor.BN(100_000_000)).accounts({ trader: owner.publicKey, traderUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction()], "deposit 100 more (now on L1)");
  await send(base, owner, [await prog.methods.delegateUserBalance().accounts({ payer: owner.publicKey, userBalance: ub }).instruction()], "re-delegate user_balance");
  await waitER([market, pool, ub, book]);
  await new Promise(r=>setTimeout(r,3000));
  await send(er, sk, [await erp.methods.openPosition(0, { long: {} }, new anchor.BN(100_000_000), 5).accounts(erAcc).instruction()], "open 100 after top-up");

  const b = await erp.account.positionBook.fetch(book);
  const open = b.slots.filter(s=>Object.keys(s.status)[0]==="open").length;
  console.log("   open positions:", open);
  if (open !== 1) throw new Error("expected 1 open after top-up");
  console.log("\nCOLLATERAL TOP-UP VERIFIED ✓  (undelegate_user -> deposit -> re-delegate -> open works)");
})().catch(e => { console.error("FAILED:\n", e.message || e); process.exit(1); });
