// Watch a validator-orphaned trader and recover it the moment the ER validator re-accepts it.
// Periodically retries undelegate_trader (admin-paid, routed to the holding validator). Succeeds when
// the accounts return to L1 (program-owned); then the user re-provisions cleanly.
// Usage: node scripts/recover-watch.cjs <USER_WALLET> [intervalSec=60] [maxMinutes=45]
const fs = require("fs"), path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction } = require("../frontend/node_modules/@solana/web3.js");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const idl = require("../frontend/src/lib/idl/shear.json");
const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market_uc"), sym], PID);
const { BASE_RPC, ER_RPC } = require("./_env.cjs");
const ER_BY_VALIDATOR = {
  MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57: ER_RPC, // custom MagicBlock RPC (default/asia)
  MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e: "https://devnet-eu.magicblock.app",
  MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd: "https://devnet-us.magicblock.app",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userPk = new PublicKey(process.argv[2]);
  const intervalSec = Number(process.argv[3] || 60);
  const maxMinutes = Number(process.argv[4] || 45);
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const [userBalance] = PublicKey.findProgramAddressSync([Buffer.from("user_uc"), userPk.toBuffer()], PID);
  const [position] = PublicKey.findProgramAddressSync([Buffer.from("posbook_uc"), userPk.toBuffer(), market.toBuffer()], PID);
  const base = new Connection(BASE_RPC, "confirmed");
  const wallet = { publicKey: admin.publicKey, signTransaction: async (t) => (t.partialSign(admin), t), signAllTransactions: async (t) => (t.forEach((x) => x.partialSign(admin)), t) };

  const getInfo = async (addr) => { for (let i = 0; i < 6; i++) { try { return await base.getAccountInfo(addr); } catch { await sleep(1500 * (i + 1)); } } return null; };
  const validatorOf = async (addr) => { const [rec] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), addr.toBuffer()], DLP); const i = await getInfo(rec); return i && i.data.length >= 40 ? new PublicKey(i.data.subarray(8, 40)).toBase58() : null; };
  const onL1 = async () => { const b = await getInfo(userBalance), p = await getInfo(position); return b && b.owner.equals(PID) && p && p.owner.equals(PID); };

  console.log(`watching ${userPk.toBase58()} — retry every ${intervalSec}s for up to ${maxMinutes}m`);
  if (await onL1()) { console.log("RECOVERED ✓ accounts already on L1 — re-provision in the app."); return; }

  const deadline = Date.now() + maxMinutes * 60_000;
  for (let n = 1; Date.now() < deadline; n++) {
    const v = await validatorOf(userBalance);
    const erUrl = (v && ER_BY_VALIDATOR[v]) || ER_RPC;
    const er = new Connection(erUrl, "confirmed");
    const erProg = new anchor.Program(idl, new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }));
    let result;
    try {
      const tx = await erProg.methods.undelegateTrader().accounts({ payer: admin.publicKey, userBalance, position }).transaction();
      tx.feePayer = admin.publicKey;
      tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
      tx.partialSign(admin);
      const sig = await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const r = await er.confirmTransaction(sig, "confirmed");
      result = r.value.err ? "rejected (" + JSON.stringify(r.value.err) + ")" : "submitted " + sig;
    } catch (e) { result = "err " + (e.message || e).slice(0, 80); }
    console.log(`[${new Date().toISOString()}] attempt ${n} via ${erUrl}: ${result}`);
    await sleep(4000);
    if (await onL1()) { console.log("RECOVERED ✓ accounts back on L1 — re-provision in the app and trade."); return; }
    await sleep(intervalSec * 1000);
  }
  console.log(`still orphaned after ${maxMinutes}m. The MAS1Dt9 validator hasn't re-acquired the account.`);
  console.log("Options: keep waiting (re-run this), trade from a fresh wallet, or ping MagicBlock devnet support to clear it.");
  process.exit(1);
})().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
