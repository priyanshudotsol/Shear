// SHEAR demo scenario.
//
// The market-neutral claim (long SOL-ETH 10x stays green at +~45% while a directional long-SOL 10x
// liquidates, on a scripted SOL -8% / ETH -12% move) is DETERMINISTICALLY proven at the engine level
// in `programs/shear-math/src/lib.rs::tests::worked_example_demo` (uPnL = +$45.454540 to the unit) and
// `engine::tests::liquidate_*`. The on-chain devnet oracle can't be scripted to an exact move, so this
// file drives the live program and prints the real-time ratio + position equity for the demo recording.
//
// To assert exact numbers on-chain, deploy a MOCK PriceUpdateV2 feed you control (write SOL=$138, ETH=$2640)
// and bind the market to it; then the +45% / liquidation outcomes reproduce exactly.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";

const SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ETH_USD = new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
const seed = (s: string) => Buffer.from(s);
const sym = (() => { const b = Buffer.alloc(16); b.write("SOL-ETH"); return b; })();

describe("shear demo scenario (live)", () => {
  const base = anchor.AnchorProvider.env();
  anchor.setProvider(base);
  const program = anchor.workspace.Shear as anchor.Program;
  const er = new Connection(process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app", "confirmed");
  const pid = program.programId;
  const w = base.wallet.publicKey;
  const [market] = PublicKey.findProgramAddressSync([seed("market"), sym], pid);
  const [pool] = PublicKey.findProgramAddressSync([seed("pool"), market.toBuffer()], pid);
  const [userBal] = PublicKey.findProgramAddressSync([seed("user"), w.toBuffer()], pid);
  const [position] = PublicKey.findProgramAddressSync([seed("position"), w.toBuffer(), market.toBuffer()], pid);

  it("open long SOL-ETH 10x and print live equity (assumes setup + delegation already done)", async () => {
    const accts = { signer: w, market, pool, userBalance: userBal, position, basePrice: SOL_USD, quotePrice: ETH_USD, sessionToken: null };
    const tx = await program.methods.openPosition({ long: {} }, new anchor.BN(100_000_000), 10).accounts(accts).transaction();
    tx.feePayer = w; tx.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    const signed = await (base.wallet as any).signTransaction(tx);
    await er.sendRawTransaction(signed.serialize(), { skipPreflight: true });

    // poll the ratio + position for the demo (the chart re-ticks at the oracle pusher cadence ~200ms)
    for (let i = 0; i < 10; i++) {
      const pos = await (program.account as any).position.fetch(position);
      console.log(`entry_ratio(1e9)=${pos.entryRatio.toString()}  notional=${pos.notional.toString()}  collateral=${pos.collateral.toString()}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    // close
    const ctx2 = await program.methods.closePosition().accounts(accts).transaction();
    ctx2.feePayer = w; ctx2.recentBlockhash = (await er.getLatestBlockhash()).blockhash;
    const s2 = await (base.wallet as any).signTransaction(ctx2);
    await er.sendRawTransaction(s2.serialize(), { skipPreflight: true });
  });
});
