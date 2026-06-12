// Turn the SOL-ETH market into an amplified relative-value index so the chart actually moves and
// liquidations can fire: anchor ref_ratio at the live ratio and set amp_bps (deviation multiplier).
//   undelegate market+pool to L1 -> set_market_vol(ref_ratio, amp_bps) -> re-delegate.
// Usage: node scripts/set-vol.cjs [amp_bps]   (default 100000 = 10x; 10000 = 1x/off)
// NOTE: amp_bps MUST match frontend PARAMS.volAmpBps, and the IDL must be rebuilt first
//       (anchor build) so setMarketVol exists on the program methods.
const fs = require("fs"), path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("../frontend/node_modules/@solana/web3.js");

const AMP_BPS = Number(process.argv[2] || 100_000);
const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const idl = require("../frontend/src/lib/idl/shear.json");
const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config_uc")], PID);
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market_uc"), sym], PID);
const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool_uc"), market.toBuffer()], PID);
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const er = new Connection("https://devnet.magicblock.app", "confirmed");

// Pyth Hermes feed ids (Crypto) — same as frontend constants.
const SOL_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const ETH_ID = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";

// Live ratio scaled 1e9 = (SOL/USD ÷ ETH/USD) * 1e9 — matches on-chain compute_ratio (expos cancel).
async function liveRefRatio() {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x${SOL_ID}&ids[]=0x${ETH_ID}&parsed=true`;
  const res = await fetch(url);
  const json = await res.json();
  const px = {};
  for (const p of json.parsed) px[p.id.toLowerCase().replace(/^0x/, "")] = Number(p.price.price) * Math.pow(10, p.price.expo);
  const sol = px[SOL_ID], eth = px[ETH_ID];
  if (!(sol > 0 && eth > 0)) throw new Error(`bad Pyth prices SOL=${sol} ETH=${eth}`);
  return { sol, eth, ratio1e9: new anchor.BN(Math.round((sol / eth) * 1e9)) };
}

(async () => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const wallet = { publicKey: kp.publicKey, signTransaction: async (t) => (t.partialSign(kp), t), signAllTransactions: async (t) => (t.forEach((x) => x.partialSign(kp)), t) };
  const baseProg = new anchor.Program(idl, new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }));
  const erProg = new anchor.Program(idl, new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }));

  const { sol, eth, ratio1e9 } = await liveRefRatio();
  console.log(`live SOL=${sol.toFixed(2)} ETH=${eth.toFixed(2)} -> ref_ratio(1e9)=${ratio1e9.toString()}, amp_bps=${AMP_BPS} (${AMP_BPS / 10000}x)`);

  // 1. undelegate market+pool to L1 (if delegated)
  const onER = await er.getAccountInfo(market);
  if (onER) {
    const tx = await erProg.methods.undelegateShared().accounts({ payer: kp.publicKey, market, pool }).transaction();
    tx.feePayer = kp.publicKey; tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash; tx.partialSign(kp);
    await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 25; i++) { const b = await base.getAccountInfo(market); if (b && b.owner.equals(PID)) break; await new Promise(r => setTimeout(r, 1500)); }
    console.log("undelegated market+pool to L1");
  }

  // 2. set the volatility index on L1
  await baseProg.methods.setMarketVol(ratio1e9, AMP_BPS).accounts({ admin: kp.publicKey, config, market }).rpc();
  console.log(`set_market_vol OK — index anchored, amp ${AMP_BPS / 10000}x`);

  // 3. re-delegate market + pool to the ER
  await baseProg.methods.delegateMarket([...sym]).accounts({ payer: kp.publicKey, market }).rpc({ skipPreflight: true });
  await baseProg.methods.delegatePool().accounts({ payer: kp.publicKey, market, pool }).rpc({ skipPreflight: true });
  console.log("re-delegated market+pool to the ER. Amplified index live.");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
