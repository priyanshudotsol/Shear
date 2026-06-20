"use client";

// Real on-chain writes for the SHEAR program, signed by the connected wallet.
// NOTE: deposit_liquidity / withdraw_liquidity are base-layer instructions that
// write the `pool` account. If the pool is delegated to the ER, the base tx will
// be rejected - callers should check isPoolDelegated() first and surface that.
import { Buffer } from "buffer";
import { AnchorProvider, Program, BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import idlJson from "./idl/shear.json";
import { pda, programId, baseConn } from "./chain";

if (typeof window !== "undefined") {
  (window as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
}

export interface SignerWallet {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
}

// Returns `any` deliberately: typing methods off a runtime IDL blows up TS generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProgram(wallet: SignerWallet): any {
  const provider = new AnchorProvider(baseConn, wallet, { commitment: "confirmed" });
  return new Program(idlJson as Idl, provider);
}

const toBase = (usdc: number) => new BN(Math.round(usdc * 1e6));

export async function depositLiquidity(
  wallet: SignerWallet,
  symbol: string,
  usdcMint: PublicKey,
  amountUsdc: number
): Promise<string> {
  const program = getProgram(wallet);
  const market = pda.market(symbol);
  const lpUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  return program.methods
    .depositLiquidity(toBase(amountUsdc))
    .accounts({ lp: wallet.publicKey, market, lpUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([
      // create the LP's mock-USDC ATA if it doesn't exist yet (idempotent)
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, lpUsdc, wallet.publicKey, usdcMint),
    ])
    .rpc();
}

export async function withdrawLiquidity(
  wallet: SignerWallet,
  symbol: string,
  usdcMint: PublicKey,
  shares: number
): Promise<string> {
  const program = getProgram(wallet);
  const market = pda.market(symbol);
  const lpUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  // shares are u128, 1e6-scaled
  const sharesScaled = new BN(Math.round(shares * 1e6));
  return program.methods
    .withdrawLiquidity(sharesScaled)
    .accounts({ lp: wallet.publicKey, market, lpUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
}

// Mint real, transferable test-USDC of the program's mint to the connected wallet (capped on-chain).
// Replaces the old client-side "faucet" simulation - these are real tokens you can deposit + withdraw.
export async function faucet(wallet: SignerWallet, usdcMint: PublicKey): Promise<string> {
  const program = getProgram(wallet);
  const ata = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  return program.methods
    .faucet()
    .accounts({ recipient: wallet.publicKey, usdcMint, recipientUsdc: ata, tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, usdcMint),
    ])
    .rpc();
}

// Create the trader's UserBalance once, on L1, before delegation. Idempotent at the call site:
// callers should skip this if the account already exists (init fails on a live account).
export async function initUserBalance(wallet: SignerWallet): Promise<string> {
  const program = getProgram(wallet);
  return program.methods.initUserBalance().accounts({ trader: wallet.publicKey }).rpc();
}

// L1: pull real USDC into the vault and STAGE it on the trader's shuttle (shuttle.deposit_amt).
// This does NOT credit free_collateral — that happens on the ER via claim_deposit. Works whether or
// not UserBalance is delegated, because the shuttle is a separate account that lives on L1 here.
export async function depositCollateral(
  wallet: SignerWallet,
  usdcMint: PublicKey,
  amountUsdc: number
): Promise<string> {
  const program = getProgram(wallet);
  const traderUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  return program.methods
    .depositCollateral(toBase(amountUsdc))
    .accounts({ trader: wallet.publicKey, traderUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, traderUsdc, wallet.publicKey, usdcMint),
    ])
    .rpc();
}

// L1: pay out everything the trader debited from free_collateral via request_withdraw on the ER
// (shuttle.withdraw_amt -> wallet, vault -> ATA). The shuttle must already be back on L1 (undelegated)
// carrying the committed withdraw_amt. Pays the whole staged amount; no parameter.
export async function settleWithdraw(wallet: SignerWallet, usdcMint: PublicKey): Promise<string> {
  const program = getProgram(wallet);
  const traderUsdc = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
  return program.methods
    .settleWithdraw()
    .accounts({ trader: wallet.publicKey, traderUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, traderUsdc, wallet.publicKey, usdcMint),
    ])
    .rpc();
}

export const programIdStr = programId.toBase58();
