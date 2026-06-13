// SHEAR: close a live ER trading session.
// Commits the latest Market + Pool state from the ER and undelegates them back to L1 via
// `undelegate_shared` (commit_and_undelegate). Once settled, base-layer LP deposit/withdraw work
// again. The vault holding real USDC is never delegated, so trader withdrawals are unaffected.
//
// `undelegate_shared` is a #[commit] handler that EXECUTES IN THE ER, so the tx is sent to the ER
// endpoint (Anchor auto-resolves the magic_context / magic_program accounts from the IDL).
//
// Usage: ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... ts-node scripts/session-end.ts

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";

const seed = (s: string) => Buffer.from(s);
const sym = (() => { const b = Buffer.alloc(16); b.write("SOL-ETH"); return b; })();

(async () => {
  const base = anchor.AnchorProvider.env();
  anchor.setProvider(base);
  const program = anchor.workspace.Shear as anchor.Program;
  const pid = program.programId;
  const w = base.wallet.publicKey;

  const [market] = PublicKey.findProgramAddressSync([seed("market_uc"), sym], pid);
  const [pool] = PublicKey.findProgramAddressSync([seed("pool_uc"), market.toBuffer()], pid);

  const er = new anchor.AnchorProvider(
    new Connection(process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app", {
      wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app",
      commitment: "confirmed",
    }),
    base.wallet
  );
  const programER = new anchor.Program(program.idl as any, er);

  const tx = await programER.methods.undelegateShared().accounts({ payer: w, market, pool }).transaction();
  tx.feePayer = w;
  tx.recentBlockhash = (await er.connection.getLatestBlockhash()).blockhash;
  const signed = await (base.wallet as any).signTransaction(tx);
  const sig = await er.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });

  console.log("session ended: market+pool committed + undelegated to L1. LP is open again.");
  console.log("undelegate_shared sig:", sig);
})();
