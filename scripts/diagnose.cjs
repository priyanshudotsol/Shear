// Diagnose why a trader hits InvalidWritableAccount. Prints, for every account a trade touches,
// whether it's delegated and to WHICH ER validator — the co-delegation rule needs them all on one.
// Usage: node scripts/diagnose.cjs <YOUR_WALLET_PUBKEY>
const { PublicKey, Connection } = require("../frontend/node_modules/@solana/web3.js");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const enc = (s) => new TextEncoder().encode(s);
const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const VALIDATOR_NAME = {
  MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57: "asia/default (devnet.magicblock.app)",
  MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e: "europe (devnet-eu)",
  MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd: "usa (devnet-us)",
};

(async () => {
  const owner = new PublicKey(process.argv[2]);
  const { BASE_RPC, ER_RPC } = require("./_env.cjs");
  const base = new Connection(BASE_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  const market = PublicKey.findProgramAddressSync([enc("market_uc"), sym], PID)[0];
  const accts = {
    market,
    pool: PublicKey.findProgramAddressSync([enc("pool_uc"), market.toBuffer()], PID)[0],
    user_balance: PublicKey.findProgramAddressSync([enc("user_uc"), owner.toBuffer()], PID)[0],
    position: PublicKey.findProgramAddressSync([enc("posbook_uc"), owner.toBuffer(), market.toBuffer()], PID)[0],
    shuttle: PublicKey.findProgramAddressSync([enc("shuttle_uc"), owner.toBuffer()], PID)[0],
  };
  const validatorOf = async (addr) => {
    const [rec] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), addr.toBuffer()], DLP);
    const info = await base.getAccountInfo(rec);
    if (!info || info.data.length < 40) return null;
    return new PublicKey(info.data.subarray(8, 40)).toBase58();
  };

  console.log("owner:", owner.toBase58());
  console.log("ER endpoint identity:", (await er.getAccountInfo(PID)) ? "" : "", "(default = MAS1Dt9…)\n");
  const validators = new Set();
  for (const [name, addr] of Object.entries(accts)) {
    const b = await base.getAccountInfo(addr);
    if (!b) { console.log(`${name.padEnd(13)} : MISSING on L1 (not created yet)`); continue; }
    const delegated = !b.owner.equals(PID);
    const v = delegated ? await validatorOf(addr) : null;
    if (delegated && v) validators.add(v);
    const e = await er.getAccountInfo(addr);
    console.log(`${name.padEnd(13)} : ${delegated ? "DELEGATED" : "on L1     "} | validator ${v ? (VALIDATOR_NAME[v] || v) : "-"} | onER:${!!(e && e.data.length)}`);
  }
  console.log();
  const tradeAccts = ["market", "pool", "user_balance", "position"];
  const vs = new Set();
  for (const n of tradeAccts) { const b = await base.getAccountInfo(accts[n]); if (b && !b.owner.equals(PID)) vs.add(await validatorOf(accts[n])); }
  if (vs.size === 0) console.log("VERDICT: trade accounts are on L1 (not delegated) — start/resume a session, then provision.");
  else if (vs.size === 1) console.log("VERDICT: all trade accounts share ONE validator — co-delegation OK. If trades still fail, the ER may need a re-delegate (reload after the fix).");
  else console.log("VERDICT: ❌ trade accounts are SPLIT across", vs.size, "validators:", [...vs].map((v) => VALIDATOR_NAME[v] || v).join(" , "), "\n=> This is the InvalidWritableAccount cause. Run: node scripts/reset-trader.cjs " + owner.toBase58());
})().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
