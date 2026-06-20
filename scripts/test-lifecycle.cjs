// Full lifecycle on the CURRENT program (shuttle collateral model). Verifies:
//   fund -> init+stage deposit -> delegate -> claim_deposit (ER) -> open -> close
//   -> request_withdraw (ER) -> settle_withdraw (L1), with USDC actually returning to the wallet.
// The trading unit (UserBalance + PositionBook) stays delegated the whole time; collateral moves only
// through the per-trader shuttle. Run: node scripts/test-lifecycle.cjs
// Requires the admin (devnet-trading-wallet) to hold ~6 Circle USDC + ~0.1 SOL.
const S = require("./_shear.cjs");

(async () => {
  const admin = S.loadAdmin();
  const owner = S.Keypair.generate(), session = S.Keypair.generate();
  console.log("owner:", owner.publicKey.toBase58());

  const ownerAta = await S.fundOwner(admin, owner, session, { usdc: 6 });
  const usdcBefore = (await S.base.getTokenAccountBalance(ownerAta)).value.uiAmount;

  // provision: stages a 5-USDC deposit and claims it onto the ER as free_collateral
  await S.provision(owner, session, ownerAta, 5);
  console.log("   free_collateral on ER:", await S.freeCollateral(owner.publicKey), "USDC");

  // --- open then close on the ER (session-key signed) ---
  const erp = S.prog(S.er, S.wallet(session));
  const acc = S.erAccounts(session, owner);
  await S.send(S.er, session, [await erp.methods.openPosition(0, { long: {} }, S.usdc(2), 2).accounts(acc).instruction()], "open #1 (slot 0)");
  await S.send(S.er, session, [await erp.methods.closePosition(0).accounts(acc).instruction()], "close #1");

  // --- withdraw all free collateral back to the wallet via the shuttle (no undelegation) ---
  const free = await S.freeCollateral(owner.publicKey);
  console.log("   free_collateral after close:", free, "USDC — withdrawing all");
  await S.withdrawShuttle(owner, session, free, ownerAta);

  const usdcAfter = (await S.base.getTokenAccountBalance(ownerAta)).value.uiAmount;
  console.log(`   wallet USDC: ${usdcBefore} -> ${usdcAfter}`);
  if (usdcAfter <= usdcBefore - 5 + free - 0.01) throw new Error("withdraw did not return USDC to the wallet");
  console.log("\nLIFECYCLE (shuttle deposit + trade + shuttle withdraw) VERIFIED ✓");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
