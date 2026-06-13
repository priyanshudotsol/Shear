// SHEAR on-chain parameters mirrored for the client (source: programs/shear state + MATH.md).
// The frontend recomputes PnL/equity/liq locally on every oracle tick; these must match chain.

export const PROGRAM_ID = "6MmNvgdPtujGAnoFFn3V74RYR6vgyTVA7EAKPBEussGi";

// The public devnet RPC (api.devnet.solana.com) is aggressively rate-limited (HTTP 429). For a
// smooth demo set NEXT_PUBLIC_RPC_URL to a dedicated devnet endpoint (free Helius/QuickNode/Alchemy
// key), e.g. NEXT_PUBLIC_RPC_URL=https://devnet.helius-rpc.com/?api-key=XXXX in frontend/.env.local.
export const ENDPOINTS = {
  base: process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com",
  er: process.env.NEXT_PUBLIC_ER_URL || "https://devnet.magicblock.app",
  erWs: process.env.NEXT_PUBLIC_ER_WS || "wss://devnet.magicblock.app",
  router: "https://devnet-router.magicblock.app",
};

// MagicBlock real-time oracle feeds (devnet) - bound to the SOL-ETH market.
export const FEEDS = {
  oracleProgram: "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd",
  solUsd: "ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu",
  ethUsd: "5vaYr1hpv8yrSpu8w3K95x22byYxUJCCNCSYJtqVWPvG",
};

// Pyth Hermes price service - live SOL/ETH/BTC USD streamed over SSE.
// Feed IDs from https://pyth.network/developers/price-feed-ids (Crypto).
export const PYTH = {
  hermes: "https://hermes.pyth.network",
  ids: {
    SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  } as Record<string, string>,
};

// Market params (GlobalConfig + Market defaults, bps where noted).
export const PARAMS = {
  takerFeeBps: 6, // 0.06%
  liqPenaltyBps: 100, // 1%
  liqRewardShareBps: 5000, // 50% of penalty to liquidator
  insuranceCutBps: 1000, // 10% of fees to insurance
  maxLeverage: 50,
  mmrBps: 150, // maintenance margin 1.5% (lowered from 5% so 50x opens above MMR; IMR@50x=2% > 1.5%)
  kFundingBps: 1000, // funding coeff (10%/hr at full skew, pre-clamp)
  fMaxBps: 5, // funding cap 0.05%/hr
  oiCapAbs: 1_000_000, // gross OI cap (USDC)
  maxNetUtilBps: 9000, // |net_oi| <= 90% of pool (relaxed for small devnet pools)
  minCollateral: 1, // USDC
  minPositionNotional: 1, // USDC
  maxAgeSec: 2,
  maxRatioConfBps: 50,
  fundingIntervalSecs: 3600,
  // Volatility amplification for the relative-value index (1e4 = 1x identity; 100_000 = 10x).
  // MUST match the on-chain market.amp_bps set via scripts/set-vol.cjs, or the UI's predicted
  // PnL/liquidation will diverge from what the chain settles.
  volAmpBps: 100_000,
};

export const BPS = 10_000;

// Devnet USDC mints (6 decimals). Wallets may hold USDC under either, depending on
// which faucet they used - we sum across all of them when reading the balance.
//   - Gh9Zw… : the SPL token-faucet "USDC-Dev" (spl-token-faucet.com, Saber, etc.)
//   - 4zMMC… : Circle's official devnet USDC (faucet.circle.com)
// The protocol is bound to Circle's official devnet USDC. Get it from https://faucet.circle.com.
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_MINTS_DEVNET = ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"];
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com";

// SPL token program IDs (scan both so Token-2022 balances are picked up too).
export const TOKEN_PROGRAM_IDS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

// Markets are config-only: a pair of Pyth-priced assets (BASE/USD ÷ QUOTE/USD).
// The engine is market-generic; add a row here to list a new pair.
export interface MarketConfig {
  symbol: string;
  base: string; // asset key into PYTH.ids / SPOT
  quote: string;
  seedLongOi: number;
  seedShortOi: number;
}

// Only SOL-ETH is deployed on-chain, so it's the only market we surface (no fake
// OI/pool for undeployed pairs). Add a row here once a pair is created on-chain.
export const MARKETS: MarketConfig[] = [
  { symbol: "SOL-ETH", base: "SOL", quote: "ETH", seedLongOi: 0, seedShortOi: 0 },
];

export const DEFAULT_MARKET = MARKETS[0].symbol;

// Reference spot prices for the simulated live engine (anchor + reasonable drift).
// Placeholder spot prices (per asset) used only before the first live Pyth tick.
export const SPOT: Record<string, number> = {
  SOL: 150,
  ETH: 2900,
  BTC: 62000,
};

// Devnet test-USDC faucet. Each wallet is granted this once on first connect;
// deposits draw from the wallet balance, so you can't fund/trade beyond it.
export const FAUCET_AMOUNT = 10_000;

export const FAMILY = [
  { name: "SHIM", category: "FBA-DEX", meaning: "A slice of time where all orders clear at one price" },
  { name: "SLIP", category: "Copy-trade vault", meaning: "Slipstream behind a leader; zero slippage" },
  { name: "SHEAR", category: "Ratio perp DEX", meaning: "The tradeable relationship between two assets", active: true },
];
