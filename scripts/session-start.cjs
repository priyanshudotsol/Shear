// One-off: open a live ER trading session — delegate market + pool to the ER.
// Run: node scripts/session-start.cjs
const fs = require("fs");
const path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("../frontend/node_modules/@solana/web3.js");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const BASE = "https://api.devnet.solana.com";
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
  const conn = new Connection(BASE, "confirmed");
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);

  const sig1 = await program.methods.delegateMarket([...sym]).accounts({ payer: kp.publicKey, market }).rpc({ skipPreflight: true });
  console.log("delegate_market:", sig1);
  const sig2 = await program.methods.delegatePool().accounts({ payer: kp.publicKey, market, pool }).rpc({ skipPreflight: true });
  console.log("delegate_pool:  ", sig2);
  console.log("session started — market + pool delegated to the ER. Trading is live.");
})().catch((e) => { console.error("FAILED:", e.message || e); process.exit(1); });
