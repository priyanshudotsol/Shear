// Recover a stuck trader: undelegate their user_balance + position back to L1 so they can
// re-provision cleanly. Admin pays. Usage: node scripts/reset-trader.cjs <USER_WALLET_PUBKEY>
const fs = require("fs");
const path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction } = require("../frontend/node_modules/@solana/web3.js");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const idl = require("../frontend/src/lib/idl/shear.json");
const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market_uc"), sym], PID);

(async () => {
  const userPk = new PublicKey(process.argv[2]);
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const [userBalance] = PublicKey.findProgramAddressSync([Buffer.from("user_uc"), userPk.toBuffer()], PID);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("posbook_uc"), userPk.toBuffer(), market.toBuffer()], PID);

  const base = new Connection("https://api.devnet.solana.com", "confirmed");
  const erConn = new Connection("https://devnet.magicblock.app", "confirmed");

  // report current state
  for (const [n, k] of [["userBalance", userBalance], ["position", position]]) {
    const b = await base.getAccountInfo(k), e = await erConn.getAccountInfo(k);
    console.log(`${n}: L1 owner ${b ? b.owner.toBase58().slice(0, 12) : "none"} | onER ${!!e}`);
  }

  const wallet = { publicKey: admin.publicKey, signTransaction: async (t) => (t.partialSign(admin), t), signAllTransactions: async (t) => (t.forEach((x) => x.partialSign(admin)), t) };
  const erProg = new anchor.Program(idl, new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" }));

  // undelegate_trader runs in the ER (commit_and_undelegate); admin is the payer
  const tx = await erProg.methods.undelegateTrader().accounts({ payer: admin.publicKey, userBalance, position }).transaction();
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
  tx.partialSign(admin);
  const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const r = await erConn.confirmTransaction(sig, "confirmed");
  if (r.value.err) {
    const t = await erConn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    throw new Error("undelegate_trader err: " + JSON.stringify(r.value.err) + "\n" + (t?.meta?.logMessages || []).join("\n"));
  }
  console.log("undelegate_trader sent:", sig);

  // poll L1 until both are program-owned again
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const b = await base.getAccountInfo(userBalance), p = await base.getAccountInfo(position);
    if (b && b.owner.equals(PID) && p && p.owner.equals(PID)) { console.log("RESET ✓ both accounts back on L1 — re-provision will work now."); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("submitted; L1 settlement still propagating — recheck in a moment.");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
