// Relax the SOL-ETH market risk params so small positions work with a small (Circle-faucet) pool:
// undelegate market+pool to L1 -> set_market_risk -> re-delegate. Run: node scripts/relax-market.cjs
const fs = require("fs"), path = require("path");
const anchor = require("../frontend/node_modules/@coral-xyz/anchor");
const { PublicKey, Connection, Keypair, Transaction } = require("../frontend/node_modules/@solana/web3.js");

const PID = new PublicKey("6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi");
const idl = require("../frontend/src/lib/idl/shear.json");
const sym = Buffer.alloc(16); sym.write("SOL-ETH");
const [config] = PublicKey.findProgramAddressSync([Buffer.from("config_uc")], PID);
const [market] = PublicKey.findProgramAddressSync([Buffer.from("market_uc"), sym], PID);
const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool_uc"), market.toBuffer()], PID);
const base = new Connection("https://api.devnet.solana.com", "confirmed");
const er = new Connection("https://devnet.magicblock.app", "confirmed");

(async () => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/devnet-trading-wallet.json"), "utf8"))));
  const wallet = { publicKey: kp.publicKey, signTransaction: async (t) => (t.partialSign(kp), t), signAllTransactions: async (t) => (t.forEach((x) => x.partialSign(kp)), t) };
  const baseProg = new anchor.Program(idl, new anchor.AnchorProvider(base, wallet, { commitment: "confirmed" }));
  const erProg = new anchor.Program(idl, new anchor.AnchorProvider(er, wallet, { commitment: "confirmed" }));

  // 1. undelegate market+pool to L1 (if delegated)
  const onER = await er.getAccountInfo(market);
  if (onER) {
    const tx = await erProg.methods.undelegateShared().accounts({ payer: kp.publicKey, market, pool }).transaction();
    tx.feePayer = kp.publicKey; tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash; tx.partialSign(kp);
    await er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (let i = 0; i < 25; i++) { const b = await base.getAccountInfo(market); if (b && b.owner.equals(PID)) break; await new Promise(r => setTimeout(r, 1500)); }
    console.log("undelegated market+pool to L1");
  }

  // 2. relax risk params (90% pool util, 5 USDC minimums) on L1
  await baseProg.methods.setMarketRisk({
    maxLeverage: 50, mmrBps: 150, maxNetUtilBps: 9000,
    oiCapAbs: new anchor.BN(1_000_000_000_000),
    minCollateral: new anchor.BN(5_000_000),         // 5 USDC
    minPositionNotional: new anchor.BN(5_000_000),   // 5 USDC
  }).accounts({ admin: kp.publicKey, config, market }).rpc();
  console.log("set_market_risk OK — max_net_util 90%, min collateral/notional 5 USDC");

  // 3. re-delegate market + pool to the ER
  await baseProg.methods.delegateMarket([...sym]).accounts({ payer: kp.publicKey, market }).rpc({ skipPreflight: true });
  await baseProg.methods.delegatePool().accounts({ payer: kp.publicKey, market, pool }).rpc({ skipPreflight: true });
  console.log("re-delegated market+pool to the ER. Trading live with relaxed params.");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
