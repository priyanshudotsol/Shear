// PROVE multiple positions: one trader opens 3 positions in different slots and closes them
// individually (session key signs the ER ops). Run: node scripts/test-multi.cjs
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

async function send(conn, kp, ixs, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await conn.confirmTransaction(sig, "confirmed");
  if (r.value.err) { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); throw new Error(`${label}: ` + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).slice(-6).join("\n")); }
  console.log(`   ${label} OK`);
}
const onER = async k => { const i = await er.getAccountInfo(k); return !!i && i.data.length > 0; };
const waitER = async ks => { for (let i=0;i<25;i++){ if ((await Promise.all(ks.map(onER))).every(Boolean)) return; await new Promise(r=>setTimeout(r,1000)); } throw new Error("ER not ready"); };

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

  // L1 setup: faucet + deposit (enough for 3) + init book + set session key
  await send(base, owner, [
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, MINT),
    await prog.methods.faucet().accounts({ recipient: owner.publicKey, usdcMint: MINT, recipientUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.depositCollateral(new anchor.BN(400_000_000)).accounts({ trader: owner.publicKey, traderUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.initPosition().accounts({ owner: owner.publicKey, market, positionBook: book }).instruction(),
    await prog.methods.setSessionKey(sk.publicKey).accounts({ owner: owner.publicKey, userBalance: ub }).instruction(),
  ], "faucet+deposit+initBook+setSessionKey");
  await send(base, owner, [await prog.methods.delegateUserBalance().accounts({ payer: owner.publicKey, userBalance: ub }).instruction()], "delegate user_balance");
  await send(base, owner, [await prog.methods.delegatePosition().accounts({ payer: owner.publicKey, market, position: book }).instruction()], "delegate book");
  await waitER([market, pool, ub, book]);

  // open 3 positions in slots 0, 1, 2 (session key signs)
  await send(er, sk, [await erp.methods.openPosition(0, { long: {} }, new anchor.BN(100_000_000), 5).accounts(erAcc).instruction()], "open slot 0 (long 5x)");
  await send(er, sk, [await erp.methods.openPosition(1, { short: {} }, new anchor.BN(100_000_000), 3).accounts(erAcc).instruction()], "open slot 1 (short 3x)");
  await send(er, sk, [await erp.methods.openPosition(2, { long: {} }, new anchor.BN(80_000_000), 10).accounts(erAcc).instruction()], "open slot 2 (long 10x)");

  const status = (s) => Object.keys(s)[0];
  let b = await erp.account.positionBook.fetch(book);
  let open = b.slots.map((s,i)=>({i,st:status(s.status),side:status(s.side),n:Number(s.notional)/1e6})).filter(s=>s.st==="open");
  console.log("   OPEN positions:", JSON.stringify(open));
  if (open.length !== 3) throw new Error("expected 3 open positions, got " + open.length);

  // close slot 1 only — verify 0 and 2 remain open
  await send(er, sk, [await erp.methods.closePosition(1).accounts(erAcc).instruction()], "close slot 1");
  b = await erp.account.positionBook.fetch(book);
  open = b.slots.map((s,i)=>({i,st:status(s.status)})).filter(s=>s.st==="open").map(s=>s.i);
  console.log("   still open after closing slot 1:", JSON.stringify(open));
  if (open.length !== 2 || !open.includes(0) || !open.includes(2)) throw new Error("slot-1 close affected wrong slots");

  // close the rest
  await send(er, sk, [await erp.methods.closePosition(0).accounts(erAcc).instruction()], "close slot 0");
  await send(er, sk, [await erp.methods.closePosition(2).accounts(erAcc).instruction()], "close slot 2");
  b = await erp.account.positionBook.fetch(book);
  const remaining = b.slots.filter(s=>status(s.status)==="open").length;
  console.log("   remaining open:", remaining);
  if (remaining !== 0) throw new Error("expected all closed");

  console.log("\nMULTI-POSITION VERIFIED ✓  (3 independent positions opened in slots 0/1/2 and closed individually)");
})().catch(e => { console.error("FAILED:\n", e.message || e); process.exit(1); });
