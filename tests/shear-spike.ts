// SHEAR walking-skeleton driver.
// Provider/routing pattern is copied from ../magicblock-engine-examples/anchor-counter/tests/public-counter.ts
// (two AnchorProviders: base + ER) and crank-counter for the schedule call.
// Fill PROGRAM type + feed pubkeys after `anchor build` generates the IDL.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection } from "@solana/web3.js";
import { GetCommitmentSignature, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { assert } from "chai";

const SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ETH_USD = new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
// const VALIDATOR = new PublicKey("<ER validator pubkey>"); // pin one validator for all SHEAR accounts

describe("shear-spike", () => {
  const provider = anchor.AnchorProvider.env();           // base layer (devnet)
  anchor.setProvider(provider);
  const program = anchor.workspace.Shear as anchor.Program; // typed after IDL gen

  const providerER = new anchor.AnchorProvider(
    new Connection(
      process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet.magicblock.app",
      { wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet.magicblock.app", commitment: "confirmed" }
    ),
    provider.wallet
  );

  const [probe] = PublicKey.findProgramAddressSync(
    [Buffer.from("probe"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  it("initialize (L1)", async () => {
    await program.methods.initialize().accounts({ payer: provider.wallet.publicKey, probe }).rpc();
  });

  it("delegate (L1 → ER)", async () => {
    // pass VALIDATOR as a remaining account to pin it (co-delegation rule)
    await program.methods.delegate().accounts({ payer: provider.wallet.publicKey, probe })
      /* .remainingAccounts([{ pubkey: VALIDATOR, isWritable: false, isSigner: false }]) */
      .rpc({ skipPreflight: true });
  });

  it("increment (mutate in ER)", async () => {
    const tx = await program.methods.increment().accounts({ probe }).transaction();
    tx.feePayer = providerER.wallet.publicKey;
    tx.recentBlockhash = (await providerER.connection.getLatestBlockhash()).blockhash;
    const signed = await providerER.wallet.signTransaction(tx);
    await providerER.sendAndConfirm(signed, [], { skipPreflight: true });
  });

  it("store_ratio (read two feeds in ER → ratio via math crate)", async () => {
    const tx = await program.methods.storeRatio(new anchor.BN(60))
      .accounts({ probe, basePrice: SOL_USD, quotePrice: ETH_USD }).transaction();
    tx.feePayer = providerER.wallet.publicKey;
    tx.recentBlockhash = (await providerER.connection.getLatestBlockhash()).blockhash;
    const signed = await providerER.wallet.signTransaction(tx);
    await providerER.sendAndConfirm(signed, [], { skipPreflight: true });
    // check the logs for "ratio(1e9) = ..." ~ 52_000_000 for SOL/ETH ≈ 0.052
  });

  it("schedule_crank (crank fires increment every 1s)", async () => {
    const tx = await program.methods.scheduleCrank(new anchor.BN(1), new anchor.BN(1000), new anchor.BN(5))
      .accounts({ payer: providerER.wallet.publicKey, probe, magicProgram: MAGIC_PROGRAM_ID }).transaction();
    tx.feePayer = providerER.wallet.publicKey;
    tx.recentBlockhash = (await providerER.connection.getLatestBlockhash()).blockhash;
    const signed = await providerER.wallet.signTransaction(tx);
    await providerER.sendAndConfirm(signed, [], { skipPreflight: true });
    await new Promise((r) => setTimeout(r, 6000));
    // assert probe.count climbed without further txs
  });

  it("undelegate (ER → L1)", async () => {
    const tx = await program.methods.undelegate().accounts({ payer: providerER.wallet.publicKey, probe }).transaction();
    tx.feePayer = providerER.wallet.publicKey;
    tx.recentBlockhash = (await providerER.connection.getLatestBlockhash()).blockhash;
    const signed = await providerER.wallet.signTransaction(tx);
    const sig = await providerER.sendAndConfirm(signed, [], { skipPreflight: true });
    const commitSig = await GetCommitmentSignature(sig, providerER.connection);
    await provider.connection.confirmTransaction(commitSig, "confirmed");
    const acct = await program.account.probe.fetch(probe);
    assert.ok(acct.lastRatio.gtn(0), "ratio committed to base layer");
  });
});
