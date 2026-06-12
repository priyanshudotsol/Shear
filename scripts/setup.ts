// SHEAR devnet setup (v2 — bound to Circle's devnet USDC).
// Inits config + vault + the SOL-ETH market. The pool starts EMPTY: liquidity providers seed it by
// depositing real USDC (from faucet.circle.com); traders fund collateral the same way. No mint is
// created and no faucet — the protocol uses Circle USDC, which we can't mint.
// Usage: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/devnet-trading-wallet.json npx ts-node scripts/setup.ts

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ORACLE = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const ETH_USD = new PublicKey("5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG");
// Circle's official devnet USDC (6 decimals).
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

const seed = (s: string) => Buffer.from(s);
const sym = (() => { const b = Buffer.alloc(16); b.write("SOL-ETH"); return b; })();

(async () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Shear as anchor.Program;
  const pid = program.programId;
  const w = provider.wallet.publicKey;

  const [config] = PublicKey.findProgramAddressSync([seed("config_uc")], pid);
  const [vaultAuth] = PublicKey.findProgramAddressSync([seed("vault_auth_uc")], pid);
  const [vault] = PublicKey.findProgramAddressSync([seed("vault_uc")], pid);
  const [market] = PublicKey.findProgramAddressSync([seed("market_uc"), sym], pid);
  const [pool] = PublicKey.findProgramAddressSync([seed("pool_uc"), market.toBuffer()], pid);

  // 1. init config (+ vault as a Circle-USDC token account) and the SOL-ETH market
  await program.methods.initializeConfig({
    takerFeeBps: 6, liqPenaltyBps: 100, liqRewardShareBps: 5000, insuranceCutBps: 1000,
    minCollateral: new anchor.BN(10_000_000), minPositionNotional: new anchor.BN(50_000_000),
    maxAgeSec: new anchor.BN(60), maxRatioConfBps: 50, liqMaxConfBps: 100,
  }).accounts({ admin: w, config, usdcMint: USDC, vaultAuth, vault, oracleProgram: ORACLE, tokenProgram: TOKEN_PROGRAM_ID }).rpc();
  console.log("config + vault initialized (USDC mint:", USDC.toBase58() + ")");

  await program.methods.createMarket({
    symbol: [...sym], maxLeverage: 50, mmrBps: 150, kFundingBps: 1000, fMaxBps: 5,
    oiCapAbs: new anchor.BN(1_000_000_000_000), maxNetUtilBps: 5000,
  }).accounts({ admin: w, config, market, pool, baseFeed: SOL_USD, quoteFeed: ETH_USD }).rpc();
  console.log("market:", market.toBase58());

  // Pool starts EMPTY. Liquidity providers seed it with real USDC (Pool page → Deposit liquidity);
  // traders fund collateral with real USDC too. Get devnet USDC from https://faucet.circle.com.
  // Market + Pool stay on L1 so LP works out of the box; `session-start.ts` delegates to the ER.
  console.log("setup complete (Circle USDC). Pool is empty — add liquidity, then session-start.ts to trade.");
})();
