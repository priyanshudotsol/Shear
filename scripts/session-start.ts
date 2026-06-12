// SHEAR: open a live ER trading session.
// Delegates the shared Market + Pool to the MagicBlock ER (pinning ONE validator) and registers
// the autonomous funding crank. While a session is open, trades execute on the ER — but base-layer
// LP deposit/withdraw is paused (the pool is on the ER). Close the session with `session-end.ts`.
//
// Usage: ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... ER_VALIDATOR=<pubkey> ts-node scripts/session-start.ts

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";

const VALIDATOR: PublicKey | null = process.env.ER_VALIDATOR ? new PublicKey(process.env.ER_VALIDATOR) : null;
const seed = (s: string) => Buffer.from(s);
const sym = (() => { const b = Buffer.alloc(16); b.write("SOL-ETH"); return b; })();

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Shear as anchor.Program;
  const pid = program.programId;
  const w = provider.wallet.publicKey;

  const [market] = PublicKey.findProgramAddressSync([seed("market"), sym], pid);
  const [pool] = PublicKey.findProgramAddressSync([seed("pool"), market.toBuffer()], pid);

  // delegate the shared accounts (co-delegate to the SAME validator, magicblock-integration.md §2)
  const rem = VALIDATOR ? [{ pubkey: VALIDATOR, isWritable: false, isSigner: false }] : [];
  await program.methods.delegateMarket([...sym]).accounts({ payer: w, market }).remainingAccounts(rem).rpc({ skipPreflight: true });
  await program.methods.delegatePool().accounts({ payer: w, market, pool }).remainingAccounts(rem).rpc({ skipPreflight: true });
  console.log("delegated market + pool to the ER");

  // register the autonomous funding crank (runs on the ER)
  const er = new Connection(process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app", "confirmed");
  const MAGIC = new PublicKey("Magic11111111111111111111111111111111111111");
  const crankTx = await program.methods.scheduleFundingCrank(new anchor.BN(1), new anchor.BN(1000), new anchor.BN(86400))
    .accounts({ payer: w, market, magicProgram: MAGIC }).transaction();
  crankTx.feePayer = w; crankTx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
  const signed = await (provider.wallet as any).signTransaction(crankTx);
  await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });

  console.log("session started: market+pool on the ER, funding crank scheduled. LP deposits are paused until session-end.");
})();
