// Real on-chain reads for the deployed SHEAR program (devnet).
// Config / UserBalance / Position live on the base layer; Market + Pool are delegated
// to the MagicBlock ER, so they are read from the ER endpoint.
import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor";
import idl from "./idl/shear.json";
import { PROGRAM_ID, ENDPOINTS } from "./constants";

if (typeof window !== "undefined") {
  (window as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
}

export const programId = new PublicKey(PROGRAM_ID);
export const baseConn = new Connection(ENDPOINTS.base, "confirmed");
export const erConn = new Connection(ENDPOINTS.er, "confirmed");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const coder = new BorshAccountsCoder(idl as any);

const enc = new TextEncoder();
function symbolSeed(symbol: string): Uint8Array {
  const b = new Uint8Array(16);
  b.set(enc.encode(symbol).slice(0, 16));
  return b;
}

// v2 protocol seeds (suffix "_uc") - bound to Circle's devnet USDC. Must match programs/shear constants.
export const pda = {
  config: () => PublicKey.findProgramAddressSync([enc.encode("config_uc")], programId)[0],
  market: (symbol: string) =>
    PublicKey.findProgramAddressSync([enc.encode("market_uc"), symbolSeed(symbol)], programId)[0],
  pool: (market: PublicKey) =>
    PublicKey.findProgramAddressSync([enc.encode("pool_uc"), market.toBuffer()], programId)[0],
  user: (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([enc.encode("user_uc"), owner.toBuffer()], programId)[0],
  position: (owner: PublicKey, market: PublicKey) =>
    PublicKey.findProgramAddressSync([enc.encode("posbook_uc"), owner.toBuffer(), market.toBuffer()], programId)[0],
  vaultAuth: () => PublicKey.findProgramAddressSync([enc.encode("vault_auth_uc")], programId)[0],
};

// Decoded account shapes (snake_case from the IDL). BN-like values come back as
// anchor BN; we normalise to number/string at the edges.
/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchDecoded(conn: Connection, address: PublicKey, account: string): Promise<any | null> {
  const info = await conn.getAccountInfo(address);
  if (!info) return null;
  try {
    return coder.decode(account, info.data);
  } catch {
    return null;
  }
}

const n = (v: any): number => (v == null ? 0 : typeof v === "number" ? v : Number(v.toString()));
const SCALE = 1e6; // USDC base units
const RATIO_SCALE = 1e9;

export interface ChainMarket {
  symbol: string;
  longOi: number;
  shortOi: number;
  cumFunding: number; // 1e9-scaled fractional index → fraction
  maxLeverage: number;
  mmrBps: number;
  takerFeeBps: number;
  minCollateral: number;
  minNotional: number;
  status: string;
  delegated: boolean;
}

export interface ChainPool {
  poolUsdc: number;
  totalShares: number;
  accruedFees: number;
  insuranceFund: number;
}

export interface ChainPosition {
  slot: number; // index in the position book (0..MAX_POSITIONS-1)
  side: "long" | "short";
  notional: number;
  entryRatio: number;
  collateral: number;
  entryCumFunding: number;
  status: "open" | "closed" | "liquidated";
  openedTs: number;
}

export const MAX_POSITIONS = 8;

const statusKey = (s: any): string => (s ? Object.keys(s)[0] ?? "unknown" : "unknown");

export async function fetchConfig() {
  const c = await fetchDecoded(baseConn, pda.config(), "GlobalConfig");
  if (!c) return null;
  return {
    admin: c.admin.toBase58(),
    usdcMint: c.usdc_mint.toBase58(),
    paused: c.paused as boolean,
    takerFeeBps: n(c.taker_fee_bps),
  };
}

// Market + Pool live on the ER (delegated). Falls back to base if not delegated.
export async function fetchMarket(symbol: string): Promise<ChainMarket | null> {
  const addr = pda.market(symbol);
  // Authoritative delegation check: a delegated account is no longer owned by our program on the
  // base layer. The ER router returns the account even when it's NOT delegated (it proxies the base
  // copy), so "the ER has it" is a false-positive - gating trading on that lets open_position fail
  // on-chain with InvalidWritableAccount because market/pool aren't actually delegated.
  const baseInfo = await baseConn.getAccountInfo(addr);
  const delegated = !!baseInfo && !baseInfo.owner.equals(programId);
  // Prefer fresh ER state while delegated; otherwise (or if ER hasn't cloned it yet) read base.
  let m = delegated ? await fetchDecoded(erConn, addr, "Market") : null;
  if (!m) m = await fetchDecoded(baseConn, addr, "Market");
  if (!m) return null;
  return {
    symbol: new TextDecoder().decode(Uint8Array.from(m.symbol)).replace(/\0+$/, ""),
    longOi: n(m.long_oi) / SCALE,
    shortOi: n(m.short_oi) / SCALE,
    cumFunding: n(m.cum_funding) / RATIO_SCALE,
    maxLeverage: n(m.max_leverage),
    mmrBps: n(m.mmr_bps),
    takerFeeBps: n(m.taker_fee_bps),
    minCollateral: n(m.min_collateral) / SCALE,
    minNotional: n(m.min_position_notional) / SCALE,
    status: statusKey(m.status),
    delegated,
  };
}

export async function fetchPool(market: PublicKey): Promise<ChainPool | null> {
  const addr = pda.pool(market);
  let p = await fetchDecoded(erConn, addr, "LiquidityPool");
  if (!p) p = await fetchDecoded(baseConn, addr, "LiquidityPool");
  if (!p) return null;
  return {
    poolUsdc: n(p.pool_usdc) / SCALE,
    totalShares: n(p.total_shares) / SCALE,
    accruedFees: n(p.accrued_fees) / SCALE,
    insuranceFund: n(p.insurance_fund) / SCALE,
  };
}

export async function fetchUserBalance(owner: PublicKey): Promise<number | null> {
  const u = await fetchDecoded(baseConn, pda.user(owner), "UserBalance");
  if (!u) return null;
  return n(u.free_collateral) / SCALE;
}

// Read free collateral from a specific layer (e.g. the ER, where it lives while delegated).
export async function fetchUserBalanceFrom(conn: Connection, owner: PublicKey): Promise<number | null> {
  const u = await fetchDecoded(conn, pda.user(owner), "UserBalance");
  if (!u) return null;
  return n(u.free_collateral) / SCALE;
}

// The session key currently authorized to sign this trader's ER ops (base58), from a given layer.
// Reads raw account data, so it works even while the account is delegated (owner = delegation prog).
export async function fetchSessionAuthority(conn: Connection, owner: PublicKey): Promise<string | null> {
  const u = await fetchDecoded(conn, pda.user(owner), "UserBalance");
  if (!u || !u.session_authority) return null;
  return new PublicKey(u.session_authority).toBase58();
}

// SPL balance of a given mint for an owner (used for the program's mock USDC).
export async function fetchTokenBalance(owner: PublicKey, mint: PublicKey): Promise<number> {
  try {
    const res = await baseConn.getParsedTokenAccountsByOwner(owner, { mint });
    let total = 0;
    for (const { account } of res.value) {
      total += account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    }
    return total;
  } catch {
    return 0;
  }
}

// LP shares for an owner in a market's pool.
export async function fetchLpShares(owner: PublicKey, symbol: string): Promise<number> {
  const market = pda.market(symbol);
  const pool = pda.pool(market);
  const lpPos = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("lp_uc"), owner.toBuffer(), pool.toBuffer()],
    programId
  )[0];
  const d = await fetchDecoded(baseConn, lpPos, "LpPosition");
  return d ? n(d.shares) / SCALE : 0;
}

// Is the market/pool delegated to the ER? (owned by the delegation program on base)
export async function isPoolDelegated(symbol: string): Promise<boolean> {
  const info = await baseConn.getAccountInfo(pda.pool(pda.market(symbol)));
  if (!info) return false;
  return !info.owner.equals(programId);
}

// Read the trader's position book (ER first, since open positions live there) and return every
// OPEN slot as a ChainPosition (with its slot index).
export async function fetchPositions(owner: PublicKey, symbol: string): Promise<ChainPosition[]> {
  const addr = pda.position(owner, pda.market(symbol));
  let book = await fetchDecoded(erConn, addr, "PositionBook");
  if (!book) book = await fetchDecoded(baseConn, addr, "PositionBook");
  if (!book) return [];
  const out: ChainPosition[] = [];
  (book.slots as any[]).forEach((s, slot) => {
    if (statusKey(s.status).toLowerCase() !== "open") return;
    out.push({
      slot,
      side: statusKey(s.side) === "Short" ? "short" : "long",
      notional: n(s.notional) / SCALE,
      entryRatio: n(s.entry_ratio) / RATIO_SCALE,
      collateral: n(s.collateral) / SCALE,
      entryCumFunding: n(s.entry_cum_funding) / RATIO_SCALE,
      status: "open",
      openedTs: n(s.opened_ts),
    });
  });
  return out;
}

// First available slot index for opening a new position, or -1 if the book is full.
export async function fetchFreeSlot(owner: PublicKey, symbol: string): Promise<number> {
  const addr = pda.position(owner, pda.market(symbol));
  let book = await fetchDecoded(erConn, addr, "PositionBook");
  if (!book) book = await fetchDecoded(baseConn, addr, "PositionBook");
  if (!book) return 0; // no book yet → slot 0 (provision creates it)
  const slots = book.slots as any[];
  for (let i = 0; i < slots.length; i++) {
    if (statusKey(slots[i].status).toLowerCase() !== "open") return i;
  }
  return -1; // full
}
/* eslint-enable @typescript-eslint/no-explicit-any */
