// One-off: bring the shared market+pool back to L1 via the newly-deployed undelegate_shared.
// Run: node scripts/undelegate-pool.cjs
const fs = require("fs");
const path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("../frontend/node_modules/@solana/web3.js");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const ER = "https://devnet.magicblock.app";
const idl = require("../frontend/src/lib/idl/shear.json");

const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market_uc"), sym], PID);
const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool_uc"), market.toBuffer()], PID);

(async () => {
  const kpPath = path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
  const wallet = {
    publicKey: kp.publicKey,
    signTransaction: async (tx) => { tx.partialSign(kp); return tx; },
    signAllTransactions: async (txs) => { txs.forEach((t) => t.partialSign(kp)); return txs; },
  };
  const erConn = new Connection(ER, "confirmed");
  const provider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const tx = await program.methods.undelegateShared().accounts({ payer: kp.publicKey, market, pool }).transaction();
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
  tx.partialSign(kp);
  const sig = await erConn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await erConn.confirmTransaction(sig, "confirmed");
  console.log("undelegate_shared sent to ER:", sig);
})().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
