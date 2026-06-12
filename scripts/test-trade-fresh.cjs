// Reproduce the NEW-USER browser flow with a fresh keypair: fund SOL -> faucet -> deposit -> init
// -> delegate user_balance -> delegate position -> open (ER). Exactly what frontend chain-trade does.
// Run: node scripts/test-trade-fresh.cjs
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
const erConn = new Connection("https://devnet.magicblock.app", "confirmed");

async function sendL1(kp, ixs, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash; tx.partialSign(kp);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await base.confirmTransaction(sig, "confirmed");
  if (r.value.err) { const t = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); throw new Error(`${label}: ` + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).join("\n")); }
  console.log(`   ${label} OK`);
}
async function sendER(kp, ix, label) {
  const tx = new Transaction().add(ix);
  tx.feePayer = kp.publicKey; tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash; tx.partialSign(kp);
  const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await erConn.confirmTransaction(sig, "confirmed");
  if (r.value.err) { const t = await erConn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); throw new Error(`${label}: ` + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).join("\n")); }
  console.log(`   ${label} OK`);
}

(async () => {
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const user = Keypair.generate();
  console.log("fresh user:", user.publicKey.toBase58());

  // fund the fresh wallet with SOL for fees + rent
  await sendL1(admin, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 0.15 * LAMPORTS_PER_SOL })], "fund SOL");

  const wallet = { publicKey: user.publicKey, signTransaction: async (t) => (t.partialSign(user), t) };
  const prog = new anchor.Program(idl, new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }));
  const erProg = new anchor.Program(idl, new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" }));
  const [userBalance] = PublicKey.findProgramAddressSync([Buffer.from("user"), user.publicKey.toBuffer()], PID);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("position"), user.publicKey.toBuffer(), market.toBuffer()], PID);
  const ata = getAssociatedTokenAddressSync(MINT, user.publicKey);

  // tx A: faucet + deposit + init
  await sendL1(user, [
    createAssociatedTokenAccountIdempotentInstruction(user.publicKey, ata, user.publicKey, MINT),
    await prog.methods.faucet().accounts({ recipient: user.publicKey, usdcMint: MINT, recipientUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.depositCollateral(new anchor.BN(120_000_000)).accounts({ trader: user.publicKey, traderUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction(),
    await prog.methods.initPosition().accounts({ owner: user.publicKey, market, position }).instruction(),
  ], "faucet+deposit+init");

  // delegate (separate txs)
  await sendL1(user, [await prog.methods.delegateUserBalance().accounts({ payer: user.publicKey, userBalance }).instruction()], "delegate user_balance");
  await sendL1(user, [await prog.methods.delegatePosition().accounts({ payer: user.publicKey, market, position }).instruction()], "delegate position");

  // check ER visibility before open
  for (const [n, k] of [["market", market], ["pool", pool], ["userBalance", userBalance], ["position", position]]) {
    const i = await erConn.getAccountInfo(k);
    console.log(`   ER ${n}: ${i ? "present (" + i.data.length + " bytes)" : "MISSING"}`);
  }

  // open on ER
  const erAcc = { signer: user.publicKey, market, pool, userBalance, position, basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };
  await sendER(user, await erProg.methods.openPosition({ long: {} }, new anchor.BN(100_000_000), 5).accounts(erAcc).instruction(), "OPEN");
  console.log("\nFRESH-USER OPEN VERIFIED ✓  user:", user.publicKey.toBase58());
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
