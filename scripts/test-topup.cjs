// Mid-session collateral TOP-UP via the shuttle — the scenario the shuttle was built for. The old
// flow undelegated user_balance to deposit; now we add collateral WITHOUT touching the (delegated)
// trading accounts: deposit_collateral stages on L1, claim_deposit credits it on the ER, and the
// open position keeps running the whole time. Run: node scripts/test-topup.cjs
// Requires the admin (devnet-trading-wallet) to hold ~8 Circle USDC + ~0.1 SOL.
const S = require("./_shear.cjs");

(async () => {
  const admin = S.loadAdmin();
  const owner = S.Keypair.generate(), session = S.Keypair.generate();
  console.log("owner:", owner.publicKey.toBase58());

  const ownerAta = await S.fundOwner(admin, owner, session, { usdc: 8 });

  // provision with a SMALL deposit (2 USDC) — too little for the position we want
  await S.provision(owner, session, ownerAta, 2);
  console.log("   free after provision:", await S.freeCollateral(owner.publicKey), "USDC");

  const erp = S.prog(S.er, S.wallet(session));
  const acc = S.erAccounts(session, owner);

  // try to open a position that needs ~5 collateral -> should REVERT (insufficient collateral)
  const opened = await S.send(S.er, session, [await erp.methods.openPosition(0, { long: {} }, S.usdc(5), 2).accounts(acc).instruction()], "open 5 (too little)", true);
  if (opened) throw new Error("expected insufficient-collateral revert");

  // TOP UP via the shuttle — user_balance + position stay delegated the entire time
  await S.send(S.base, owner, [await S.prog(S.base, S.wallet(owner)).methods
    .depositCollateral(S.usdc(5)).accounts({ trader: owner.publicKey, traderUsdc: ownerAta, tokenProgram: S.TOKEN_PROGRAM_ID }).instruction()],
    "stage +5 USDC (L1, user_balance still delegated)");
  if (await S.isDelegated(S.pda.user(owner.publicKey)) === false) throw new Error("user_balance was undelegated — top-up should not touch it");
  await S.claimStaged(owner, session);
  console.log("   free after top-up:", await S.freeCollateral(owner.publicKey), "USDC");

  // now the open succeeds
  await S.send(S.er, session, [await erp.methods.openPosition(0, { long: {} }, S.usdc(5), 2).accounts(acc).instruction()], "open 5 after top-up");
  const b = await erp.account.positionBook.fetch(S.pda.position(owner.publicKey, S.pda.market()));
  const open = b.slots.filter((s) => Object.keys(s.status)[0] === "open").length;
  if (open !== 1) throw new Error("expected 1 open after top-up");

  console.log("\nSHUTTLE TOP-UP VERIFIED ✓  (deposit -> claim_deposit credits free_collateral without undelegating the trading unit)");
})().catch((e) => { console.error("FAILED:\n", e.message || e); process.exit(1); });
