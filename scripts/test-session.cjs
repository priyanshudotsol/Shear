// PROVE session keys: a local session keypair (NOT the owner wallet) signs ER trades.
// owner (wallet) does L1 setup incl. set_session_key; session key signs open/close on the ER.
// Run: node scripts/test-session.cjs
const fs = require("fs");
const path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require("../frontend/node_modules/@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } =
  require("../frontend/node_modules/@solana/spl-token");

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
  if (r.value.err) { const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); throw new Error(`${label}: ` + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).slice(-8).join("\n")); }
  console.log(`   ${label} OK`);
}

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const owner = Keypair.generate();      // the "wallet"
  const sessionKey = Keypair.generate(); // the local session key (signs ER)
  console.log("owner:", owner.publicKey.toBase58());
  console.log("sessionKey:", sessionKey.publicKey.toBase58());

  // fund owner (fees+rent) and sessionKey (ER fees) from admin
  await send(base, admin, [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: owner.publicKey, lamports: 0.12 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sessionKey.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  ], "fund owner+sessionKey");

  const ownerW = { publicKey: owner.publicKey, signTransaction: async (t) => (t.partialSign(owner), t) };
  const prog = new anchor.Program(idl, new anchor.AnchorProvider(base, ownerW, { commitment: "confirmed" }));
  const erProg = new anchor.Program(idl, new anchor.AnchorProvider(er, ownerW, { commitment: "confirmed" }));
  const [userBalance] = PublicKey.findProgramAddressSync([Buffer.from("user"), owner.publicKey.toBuffer()], PID);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("position"), owner.publicKey.toBuffer(), market.toBuffer()], PID);
  const ata = getAssociatedTokenAddressSync(MINT, owner.publicKey);

  // L1 setup (owner signs): faucet + deposit + init + set_session_key
  await send(base, owner, [
    createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, ata, owner.publicKey, MINT),
    await prog.methods.faucet().accounts({ recipient: owner.publicKey, usdcMint: MINT, recipientUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.depositCollateral(new anchor.BN(120_000_000)).accounts({ trader: owner.publicKey, traderUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.initPosition().accounts({ owner: owner.publicKey, market, position }).instruction(),
    await prog.methods.setSessionKey(sessionKey.publicKey).accounts({ owner: owner.publicKey, userBalance }).instruction(),
  ], "faucet+deposit+init+set_session_key");

  // delegate (owner signs)
  await send(base, owner, [await prog.methods.delegateUserBalance().accounts({ payer: owner.publicKey, userBalance }).instruction()], "delegate user_balance");
  await send(base, owner, [await prog.methods.delegatePosition().accounts({ payer: owner.publicKey, market, position }).instruction()], "delegate position");

  // OPEN on the ER — SIGNED BY THE SESSION KEY (owner never signs this)
  const erAcc = { signer: sessionKey.publicKey, market, pool, userBalance, position, basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };
  await send(er, sessionKey, [await erProg.methods.openPosition({ long: {} }, new anchor.BN(100_000_000), 5).accounts(erAcc).instruction()], "OPEN (signed by session key)");
  const p = await erProg.account.position.fetch(position);
  console.log("   position:", Object.keys(p.side)[0], "notional", Number(p.notional)/1e6, "collateral", Number(p.collateral)/1e6);

  // CLOSE on the ER — also signed by the session key
  await send(er, sessionKey, [await erProg.methods.closePosition().accounts(erAcc).instruction()], "CLOSE (signed by session key)");
  console.log("\nSESSION-KEY TRADING VERIFIED ✓  (local key signed ER trades; owner wallet never touched them)");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
