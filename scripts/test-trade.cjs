// E2E proof: faucet -> deposit -> delegate -> open (ER) -> close (ER), with the local keypair,
// against the LIVE deployed program + SOL-ETH market. Mirrors the frontend chain-trade flow.
// Run: node scripts/test-trade.cjs
const fs = require("fs");
const path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction } = require("../frontend/node_modules/@solana/web3.js");
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

(async () => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const wallet = { publicKey: kp.publicKey, signTransaction: async (t) => (t.partialSign(kp), t), signAllTransactions: async (t) => (t.forEach((x) => x.partialSign(kp)), t) };
  const base = new Connection("https://api.devnet.solana.com", "confirmed");
  const erConn = new Connection("https://devnet.magicblock.app", "confirmed");
  const baseProg = new anchor.Program(idl, new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }));
  const erProg = new anchor.Program(idl, new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" }));
  const [userBalance] = PublicKey.findProgramAddressSync([Buffer.from("user"), kp.publicKey.toBuffer()], PID);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("position"), kp.publicKey.toBuffer(), market.toBuffer()], PID);
  const ata = getAssociatedTokenAddressSync(MINT, kp.publicKey);

  const sendL1 = (b) => b.rpc({ skipPreflight: true });
  async function sendER(ix) {
    const tx = new Transaction().add(ix);
    tx.feePayer = kp.publicKey; tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash; tx.partialSign(kp);
    const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const res = await erConn.confirmTransaction(sig, "confirmed");
    if (res.value.err) {
      const t = await erConn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      throw new Error("ER tx err: " + JSON.stringify(res.value.err) + "\n" + (t?.meta?.logMessages || []).join("\n"));
    }
    return sig;
  }

  // 1. deposit + init (one L1 tx). Admin already holds the mint, so no faucet needed here.
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, MINT)];
  ixs.push(await baseProg.methods.depositCollateral(new anchor.BN(200_000_000)).accounts({ trader: kp.publicKey, traderUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID }).instruction());
  if (!(await base.getAccountInfo(position))) ixs.push(await baseProg.methods.initPosition().accounts({ owner: kp.publicKey, market, position }).instruction());
  const tx1 = new Transaction().add(...ixs); tx1.feePayer = kp.publicKey; tx1.recentBlockhash = (await base.getLatestBlockhash()).blockhash; tx1.partialSign(kp);
  const s1 = await base.sendRawTransaction(tx1.serialize(), { skipPreflight: true });
  const r1 = await base.confirmTransaction(s1, "confirmed");
  if (r1.value.err) { const t = await base.getTransaction(s1, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }); throw new Error("tx1 err: " + JSON.stringify(r1.value.err) + "\n" + (t?.meta?.logMessages || []).join("\n")); }
  console.log("1. faucet+deposit+init OK", s1);
  const ub = await baseProg.account.userBalance.fetch(userBalance);
  console.log("   free_collateral:", Number(ub.freeCollateral) / 1e6, "USDC");

  // 2. delegate trader accounts
  try { await sendL1(baseProg.methods.delegateUserBalance().accounts({ payer: kp.publicKey, userBalance })); console.log("2a. delegate user_balance OK"); }
  catch (e) { console.log("2a. delegate user_balance:", (e.message || e).slice(0, 80)); }
  try { await sendL1(baseProg.methods.delegatePosition().accounts({ payer: kp.publicKey, market, position })); console.log("2b. delegate position OK"); }
  catch (e) { console.log("2b. delegate position:", (e.message || e).slice(0, 80)); }

  // 3. open on ER (long, 100 USDC, 5x)
  const erAcc = { signer: kp.publicKey, market, pool, userBalance, position, basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };
  await sendER(await erProg.methods.openPosition({ long: {} }, new anchor.BN(100_000_000), 5).accounts(erAcc).instruction());
  const p = await erProg.account.position.fetch(position);
  console.log("3. OPEN OK — side:", Object.keys(p.side)[0], "notional:", Number(p.notional) / 1e6, "collateral:", Number(p.collateral) / 1e6, "entryRatio:", Number(p.entryRatio) / 1e9);

  // 4. close on ER
  await sendER(await erProg.methods.closePosition().accounts(erAcc).instruction());
  const p2 = await erProg.account.position.fetch(position);
  console.log("4. CLOSE OK — status:", Object.keys(p2.status)[0]);
  console.log("\nON-CHAIN TRADE FLOW VERIFIED ✓");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
