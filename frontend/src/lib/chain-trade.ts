"use client";

// Real ER trade flow for SHEAR - provisions the trader on L1, opens/closes on the MagicBlock ER,
// and settles back to L1. Mirrors the proven sequence in tests/integration.ts:
//   deposit_collateral + init_position + delegate_user_balance + delegate_position   (L1, one tx)
//   open_position / close_position / add|remove_collateral                            (ER)
//   undelegate_trader -> poll L1 until settled -> withdraw_collateral                 (ER then L1)
//
// PREREQUISITE: the shared Market + Pool must already be delegated to the ER (an open session,
// started by scripts/session-start.ts). Until then `chainMarket.delegated` is false and trading
// is paused. The vault holding real USDC is never delegated, so withdrawals always settle on L1.
import { Buffer } from "buffer";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idlJson from "./idl/shear.json";
import { pda, programId, baseConn, erConn, fetchUserBalance, fetchUserBalanceFrom, fetchSessionAuthority, fetchTokenBalance, fetchPositions } from "./chain";
import { FEEDS, PARAMS } from "./constants";
import { getSessionKeypair } from "./session";
import { withdrawCollateral, depositLiquidity, withdrawLiquidity, type SignerWallet } from "./chain-write";

const symbol16 = (symbol: string): number[] => {
  const b = new Uint8Array(16);
  b.set(new TextEncoder().encode(symbol).slice(0, 16));
  return Array.from(b);
};

// Session key needs a little SOL on the ER to pay fees; top up when it dips below the floor.
const SESSION_KEY_FLOOR = 0.015 * LAMPORTS_PER_SOL;
const SESSION_KEY_TOPUP = 0.04 * LAMPORTS_PER_SOL;

if (typeof window !== "undefined") {
  (window as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
}

const toBase = (usdc: number) => new BN(Math.round(usdc * 1e6));
const SOL_USD = new PublicKey(FEEDS.solUsd);
const ETH_USD = new PublicKey(FEEDS.ethUsd);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function program(wallet: SignerWallet, conn = baseConn): any {
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  return new Program(idlJson as Idl, provider);
}

// Account is delegated to the ER iff it exists on L1 but is no longer owned by our program.
async function isDelegated(addr: PublicKey): Promise<boolean> {
  const info = await baseConn.getAccountInfo(addr);
  return !!info && !info.owner.equals(programId);
}
async function exists(addr: PublicKey): Promise<boolean> {
  return !!(await baseConn.getAccountInfo(addr));
}

// Pull the on-chain failure reason from a confirmed-but-errored tx (skipPreflight hides it otherwise).
async function txErrorReason(conn: Connection, sig: string): Promise<string> {
  try {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const logs = tx?.meta?.logMessages ?? [];
    const line = [...logs].reverse().find((l) => /error|failed|insufficient|panicked|custom program error/i.test(l));
    return line || JSON.stringify(tx?.meta?.err) || "unknown error";
  } catch {
    return "unknown error";
  }
}

// Send a raw signed tx and THROW if it errored on-chain (a confirmed tx can still have failed).
async function sendChecked(conn: Connection, raw: Buffer | Uint8Array, label: string): Promise<string> {
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true });
  const res = await conn.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error(`${label} failed on-chain: ${await txErrorReason(conn, sig)}`);
  return sig;
}

// Wait until accounts are visible on the ER (delegation propagates a moment after L1 confirms).
// Without this, opening immediately after delegating hits AccountDiscriminatorNotFound (0xbb9).
async function waitERReady(addrs: PublicKey[], timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const infos = await Promise.all(addrs.map((a) => erConn.getAccountInfo(a)));
    if (infos.every((i) => i && i.data.length > 0)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("accounts not ready on the ER yet - delegation is still propagating, try again in a moment");
}

// Send an ER instruction SIGNED BY THE SESSION KEY (a local keypair), not the browser wallet.
// The wallet can't simulate ER txs (foreign blockhash) so it warns/blocks; the session key just
// signs. The owner authorized this key on L1 via set_session_key, and the program's authorize()
// accepts user_balance.session_authority as a valid signer.
// Retries on InvalidWritableAccount: right after a (re-)delegation the validator may accept READS
// before it accepts WRITES to the account, so the first write can bounce - a short backoff fixes it.
async function sendERSession(owner: PublicKey, ix: TransactionInstruction, label = "ER tx"): Promise<string> {
  const kp = getSessionKeypair(owner);
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction().add(ix);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
    tx.sign(kp);
    try {
      return await sendChecked(erConn, tx.serialize(), label);
    } catch (e) {
      if (attempt < 5 && /InvalidWritableAccount|not.*delegated/i.test(String(e))) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      throw e;
    }
  }
}

const sideArg = (side: "long" | "short") => (side === "long" ? { long: {} } : { short: {} });
// `signer` is the session key; the user_balance/position-book PDAs are derived from the OWNER.
const erAccounts = (signer: PublicKey, owner: PublicKey, symbol: string) => {
  const market = pda.market(symbol);
  return {
    signer,
    market,
    pool: pda.pool(market),
    userBalance: pda.user(owner),
    positionBook: pda.position(owner, market),
    basePrice: SOL_USD,
    quotePrice: ETH_USD,
    sessionToken: null,
  };
};

// Collateral (+ fee headroom + small buffer) a position needs in free_collateral before opening.
function neededFree(collateralUsdc: number, leverage: number): number {
  const fee = collateralUsdc * leverage * (PARAMS.takerFeeBps / 1e4);
  return Math.ceil((collateralUsdc + fee) * 1.02);
}

// Undelegate ONLY user_balance back to L1 (so we can top up collateral), signed by the session key.
async function undelegateUser(wallet: SignerWallet): Promise<void> {
  const prog = program(wallet, erConn);
  const sessionPk = getSessionKeypair(wallet.publicKey).publicKey;
  const userBalance = pda.user(wallet.publicKey);
  const ix = await prog.methods.undelegateUser().accounts({ payer: sessionPk, userBalance }).instruction();
  await sendERSession(wallet.publicKey, ix, "undelegate_user");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await isDelegated(userBalance))) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// Sign one L1 tx, send it, and throw if it failed on-chain.
async function signSendL1(wallet: SignerWallet, ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await baseConn.getLatestBlockhash()).blockhash;
  const signed = await wallet.signTransaction(tx);
  return sendChecked(baseConn, signed.serialize(), label);
}

// Step 1 (L1): make sure the trader has collateral + a delegated position slot, ready to trade.
// Done as SEQUENTIAL transactions, each confirmed before the next, so every one simulates cleanly
// in the wallet (a batched deposit+delegate, or delegates signed before the deposit lands, fail
// the wallet's pre-sign simulation and trigger "may fail" warnings). Idempotent: skips done steps.
//   tx A: (faucet if needed) + deposit collateral + init position slot
//   tx B: delegate user_balance + position to the ER
export async function provisionTrader(
  wallet: SignerWallet,
  usdcMint: PublicKey,
  symbol: string,
  collateralUsdc: number,
  leverage: number
): Promise<void> {
  const prog = program(wallet);
  const market = pda.market(symbol);
  const userBalance = pda.user(wallet.publicKey);
  const position = pda.position(wallet.publicKey, market);
  const traderUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  const sessionKp = getSessionKeypair(wallet.publicKey);

  // Top up the session key's SOL for ER fees (wallet signs). Runs even on re-trades, before any ER
  // op (orphan recovery / open) so the session key can always pay its way on the rollup.
  if ((await baseConn.getBalance(sessionKp.publicKey)) < SESSION_KEY_FLOOR) {
    await signSendL1(
      wallet,
      [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: sessionKp.publicKey, lamports: SESSION_KEY_TOPUP })],
      "fund session key"
    );
  }

  let ubDelegated = await isDelegated(userBalance);
  let posDelegated = await isDelegated(position);

  // Recover ORPHANED accounts: delegated on L1 but missing/empty on the ER (a mid-session program
  // redeploy can drop or zero the ER's cloned copy). Check for real DATA, not just existence - a
  // redeploy can leave a 0-length shell that exists but can't be read. Try to undelegate back to L1
  // so the steps below can re-delegate cleanly. If even undelegate fails (the shell has no
  // discriminator), the account data was destroyed and this wallet can't trade this market.
  if (ubDelegated || posDelegated) {
    const erHasData = async (a: PublicKey) => {
      const i = await erConn.getAccountInfo(a);
      return !!i && i.data.length > 0;
    };
    const ubOk = ubDelegated ? await erHasData(userBalance) : true;
    const posOk = posDelegated ? await erHasData(position) : true;
    if (!ubOk || !posOk) {
      try {
        await settleTraderToL1(wallet, symbol);
      } catch {
        throw new Error(
          "This wallet's trading accounts were corrupted by an earlier program redeploy and can't be recovered. Please connect a different wallet to trade."
        );
      }
      ubDelegated = await isDelegated(userBalance);
      posDelegated = await isDelegated(position);
    }
  }

  // Session-key mismatch recovery: if user_balance is delegated but the session_authority it has on
  // record no longer matches THIS browser's session key (localStorage cleared, different browser, or
  // a re-generated key), every ER trade fails authorize() with Unauthorized (0x1770). Bring
  // user_balance back to L1 so the setup path below re-registers the current key via set_session_key
  // and re-delegates. undelegate_user only needs the session key as payer (no authority relation).
  if (ubDelegated) {
    const onChainAuth = await fetchSessionAuthority(erConn, wallet.publicKey);
    if (onChainAuth && onChainAuth !== sessionKp.publicKey.toBase58()) {
      await undelegateUser(wallet);
      ubDelegated = await isDelegated(userBalance);
    }
  }

  // If user_balance is delegated but doesn't hold enough free collateral for this position, bring it
  // back to L1 - you can't deposit into a delegated account. This flips ubDelegated false so the
  // deposit + re-delegate flow below tops it up. (Open positions in the book are untouched.)
  if (ubDelegated) {
    const erFree = (await fetchUserBalanceFrom(erConn, wallet.publicKey)) ?? 0;
    if (erFree < neededFree(collateralUsdc, leverage)) {
      await undelegateUser(wallet);
      ubDelegated = await isDelegated(userBalance);
    }
  }

  if (ubDelegated && posDelegated) return; // already in the ER with enough collateral

  // --- tx A: fund + create accounts (only while still on L1) ---
  if (!ubDelegated) {
    const free = (await fetchUserBalance(wallet.publicKey)) ?? 0;
    const shortfall = Math.max(0, neededFree(collateralUsdc, leverage) - free);
    const ixs: TransactionInstruction[] = [];
    if (shortfall > 0) {
      // The protocol uses Circle's devnet USDC - get it from faucet.circle.com (we can't mint it).
      const walletUsdc = await fetchTokenBalance(wallet.publicKey, usdcMint);
      if (walletUsdc < shortfall) {
        throw new Error(
          `Need ~${shortfall.toFixed(2)} USDC of collateral but your wallet holds ${walletUsdc.toFixed(2)}. Get devnet USDC at faucet.circle.com, then try again.`
        );
      }
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, traderUsdc, wallet.publicKey, usdcMint));
      ixs.push(
        await prog.methods
          .depositCollateral(toBase(shortfall))
          .accounts({ trader: wallet.publicKey, traderUsdc, tokenProgram: TOKEN_PROGRAM_ID })
          .instruction()
      );
    }
    if (!(await exists(position))) {
      ixs.push(await prog.methods.initPosition().accounts({ owner: wallet.publicKey, market, position }).instruction());
    }
    // register the session key so it can sign ER trades (authorize() accepts session_authority)
    ixs.push(await prog.methods.setSessionKey(sessionKp.publicKey).accounts({ owner: wallet.publicKey, userBalance }).instruction());
    await signSendL1(wallet, ixs, "deposit, init & session key");
  } else if (!(await exists(position))) {
    await signSendL1(wallet, [await prog.methods.initPosition().accounts({ owner: wallet.publicKey, market, position }).instruction()], "init position");
  }

  // --- delegate the trader accounts to the ER (separate txs, the proven integration.ts ordering) ---
  if (!ubDelegated) {
    await signSendL1(wallet, [await prog.methods.delegateUserBalance().accounts({ payer: wallet.publicKey, userBalance }).instruction()], "delegate balance");
  }
  if (!posDelegated) {
    await signSendL1(wallet, [await prog.methods.delegatePosition().accounts({ payer: wallet.publicKey, market, position }).instruction()], "delegate position");
  }
}

// Step 2 (ER): open a new position in `slot` (a free slot in the book). Provision first.
export async function openPositionER(
  wallet: SignerWallet,
  symbol: string,
  slot: number,
  side: "long" | "short",
  collateralUsdc: number,
  leverage: number
): Promise<string> {
  const market = pda.market(symbol);
  const sessionPk = getSessionKeypair(wallet.publicKey).publicKey;
  // ensure market/pool/user_balance/position-book are all live on the ER before opening
  await waitERReady([market, pda.pool(market), pda.user(wallet.publicKey), pda.position(wallet.publicKey, market)]);
  const prog = program(wallet, erConn);
  const ix = await prog.methods
    .openPosition(slot, sideArg(side), toBase(collateralUsdc), leverage)
    .accounts(erAccounts(sessionPk, wallet.publicKey, symbol))
    .instruction();
  return sendERSession(wallet.publicKey, ix, "open_position");
}

// Guard before an ER write to an open position (close / add / remove). Normally the accounts are
// already delegated and live on the ER, so this just waits for ER readiness. If they were settled
// back to L1 while the position was still open (an interrupted "settle & withdraw"), RE-DELEGATE
// them so the position can be closed - the validator needs a moment after a fresh delegation to
// accept writes (sendERSession retries on InvalidWritableAccount), so we also pause briefly.
async function ensureDelegatedForWrite(wallet: SignerWallet, symbol: string): Promise<void> {
  const prog = program(wallet);
  const market = pda.market(symbol);
  const userBalance = pda.user(wallet.publicKey);
  const position = pda.position(wallet.publicKey, market);
  const sessionKp = getSessionKeypair(wallet.publicKey);
  if ((await baseConn.getBalance(sessionKp.publicKey)) < SESSION_KEY_FLOOR) {
    await signSendL1(
      wallet,
      [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: sessionKp.publicKey, lamports: SESSION_KEY_TOPUP })],
      "fund session key"
    );
  }
  let reDelegated = false;
  if (!(await isDelegated(userBalance))) {
    await signSendL1(wallet, [await prog.methods.delegateUserBalance().accounts({ payer: wallet.publicKey, userBalance }).instruction()], "re-delegate balance");
    reDelegated = true;
  }
  if (!(await isDelegated(position))) {
    await signSendL1(wallet, [await prog.methods.delegatePosition().accounts({ payer: wallet.publicKey, market, position }).instruction()], "re-delegate position");
    reDelegated = true;
  }
  await waitERReady([market, pda.pool(market), userBalance, position]);
  if (reDelegated) await new Promise((r) => setTimeout(r, 3000)); // let the validator accept writes
}

// Step 3 (ER): close the position in `slot`. Settled equity lands in free_collateral (in the ER).
export async function closePositionER(wallet: SignerWallet, symbol: string, slot: number): Promise<string> {
  await ensureDelegatedForWrite(wallet, symbol);
  const sessionPk = getSessionKeypair(wallet.publicKey).publicKey;
  const prog = program(wallet, erConn);
  const ix = await prog.methods.closePosition(slot).accounts(erAccounts(sessionPk, wallet.publicKey, symbol)).instruction();
  return sendERSession(wallet.publicKey, ix, "close_position");
}

const modifyAccounts = (signer: PublicKey, owner: PublicKey, symbol: string) => {
  const market = pda.market(symbol);
  return {
    signer,
    market,
    userBalance: pda.user(owner),
    positionBook: pda.position(owner, market),
    basePrice: SOL_USD,
    quotePrice: ETH_USD,
    sessionToken: null,
  };
};

export async function addCollateralER(wallet: SignerWallet, symbol: string, slot: number, amountUsdc: number): Promise<string> {
  await ensureDelegatedForWrite(wallet, symbol);
  const prog = program(wallet, erConn);
  const sessionPk = getSessionKeypair(wallet.publicKey).publicKey;
  const ix = await prog.methods.addCollateral(slot, toBase(amountUsdc)).accounts(modifyAccounts(sessionPk, wallet.publicKey, symbol)).instruction();
  return sendERSession(wallet.publicKey, ix, "add_collateral");
}

export async function removeCollateralER(wallet: SignerWallet, symbol: string, slot: number, amountUsdc: number): Promise<string> {
  await ensureDelegatedForWrite(wallet, symbol);
  const prog = program(wallet, erConn);
  const sessionPk = getSessionKeypair(wallet.publicKey).publicKey;
  const ix = await prog.methods.removeCollateral(slot, toBase(amountUsdc)).accounts(modifyAccounts(sessionPk, wallet.publicKey, symbol)).instruction();
  return sendERSession(wallet.publicKey, ix, "remove_collateral");
}

// Step 4 (ER -> L1): commit + undelegate the trader accounts, then wait for the L1 settlement so a
// subsequent withdraw_collateral (chain-write) can pay real USDC out of the vault. Signed by the
// session key (it's the fee payer on the ER; the undelegate ix has no owner check).
export async function settleTraderToL1(wallet: SignerWallet, symbol: string): Promise<string> {
  const prog = program(wallet, erConn);
  const sessionPk = getSessionKeypair(wallet.publicKey).publicKey;
  const userBalance = pda.user(wallet.publicKey);
  const position = pda.position(wallet.publicKey, pda.market(symbol));
  const ix = await prog.methods
    .undelegateTrader()
    .accounts({ payer: sessionPk, userBalance, position })
    .instruction();
  const sig = await sendERSession(wallet.publicKey, ix, "undelegate_trader");
  // poll L1 until user_balance is program-owned again (undelegation has settled)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await isDelegated(userBalance))) return sig;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return sig;
}

// Full exit: CLOSE every open position first (settling an open position would strand it on L1 and
// brick further trading), then undelegate the trader accounts and withdraw all free collateral to
// the wallet as real USDC. Returns how many positions were closed and the amount withdrawn.
export async function settleAndWithdraw(
  wallet: SignerWallet,
  usdcMint: PublicKey,
  symbol: string,
  onStep?: (msg: string) => void
): Promise<{ closed: number; withdrawn: number }> {
  const open = await fetchPositions(wallet.publicKey, symbol);
  let closed = 0;
  for (const p of open) {
    onStep?.(`Closing position ${closed + 1}/${open.length}…`);
    await closePositionER(wallet, symbol, p.slot); // ensureDelegated handles re-delegation if needed
    closed++;
  }
  onStep?.("Settling to L1…");
  await settleTraderToL1(wallet, symbol);
  const free = (await fetchUserBalance(wallet.publicKey)) ?? 0;
  if (free <= 0) return { closed, withdrawn: 0 };
  onStep?.("Withdrawing to your wallet…");
  await withdrawCollateral(wallet, usdcMint, free);
  return { closed, withdrawn: free };
}

// ---- Liquidity provision while a trading session is live ----
// deposit/withdraw_liquidity are L1-only (token transfer + pool accounting), but trading needs the
// pool on the ER. So if the pool is delegated, briefly undelegate market+pool, do the LP op, then
// re-delegate - any LP can do this without an admin (undelegate/delegate are permissionless).
// Trading pauses for a few seconds during the swap.

async function undelegatePoolToL1(wallet: SignerWallet, symbol: string): Promise<void> {
  const market = pda.market(symbol);
  const pool = pda.pool(market);
  const sessionKp = getSessionKeypair(wallet.publicKey);
  if ((await baseConn.getBalance(sessionKp.publicKey)) < SESSION_KEY_FLOOR) {
    await signSendL1(
      wallet,
      [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: sessionKp.publicKey, lamports: SESSION_KEY_TOPUP })],
      "fund session key"
    );
  }
  const prog = program(wallet, erConn);
  const ix = await prog.methods.undelegateShared().accounts({ payer: sessionKp.publicKey, market, pool }).instruction();
  await sendERSession(wallet.publicKey, ix, "undelegate_shared");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await isDelegated(pool))) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function redelegatePool(wallet: SignerWallet, symbol: string): Promise<void> {
  const prog = program(wallet);
  const market = pda.market(symbol);
  const pool = pda.pool(market);
  await signSendL1(wallet, [await prog.methods.delegateMarket(symbol16(symbol)).accounts({ payer: wallet.publicKey, market }).instruction()], "resume trading (market)");
  await signSendL1(wallet, [await prog.methods.delegatePool().accounts({ payer: wallet.publicKey, market, pool }).instruction()], "resume trading (pool)");
}

// LP deposit that works whether or not a session is live.
export async function depositLiquidityLive(
  wallet: SignerWallet,
  usdcMint: PublicKey,
  symbol: string,
  amountUsdc: number,
  onStep?: (msg: string) => void
): Promise<string> {
  const wasDelegated = await isDelegated(pda.pool(pda.market(symbol)));
  if (wasDelegated) {
    onStep?.("Pausing trading to add liquidity…");
    await undelegatePoolToL1(wallet, symbol);
  }
  onStep?.("Depositing liquidity…");
  const sig = await depositLiquidity(wallet, symbol, usdcMint, amountUsdc);
  if (wasDelegated) {
    onStep?.("Resuming trading…");
    await redelegatePool(wallet, symbol);
  }
  return sig;
}

// LP withdraw that works whether or not a session is live.
export async function withdrawLiquidityLive(
  wallet: SignerWallet,
  usdcMint: PublicKey,
  symbol: string,
  shares: number,
  onStep?: (msg: string) => void
): Promise<string> {
  const wasDelegated = await isDelegated(pda.pool(pda.market(symbol)));
  if (wasDelegated) {
    onStep?.("Pausing trading to withdraw…");
    await undelegatePoolToL1(wallet, symbol);
  }
  onStep?.("Withdrawing liquidity…");
  const sig = await withdrawLiquidity(wallet, symbol, usdcMint, shares);
  if (wasDelegated) {
    onStep?.("Resuming trading…");
    await redelegatePool(wallet, symbol);
  }
  return sig;
}
