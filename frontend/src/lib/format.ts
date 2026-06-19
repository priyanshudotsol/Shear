export function fmtUsd(n: number, dp = 2): string {
  if (!isFinite(n)) return "-";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${sign}$${v}`;
}

export function fmtUsdSigned(n: number, dp = 2): string {
  if (!isFinite(n)) return "-";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  const v = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${sign}$${v}`;
}

// Ratio to 5 significant figures (frontend.md spec).
export function fmtRatio(n: number): string {
  if (!isFinite(n) || n <= 0) return "-";
  return n.toPrecision(5);
}

export function fmtPct(n: number, dp = 2): string {
  if (!isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(dp)}%`;
}

export function fmtPctRaw(n: number, dp = 2): string {
  if (!isFinite(n)) return "-";
  return `${(n * 100).toFixed(dp)}%`;
}

export function fmtNum(n: number, dp = 0): string {
  if (!isFinite(n)) return "-";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtCompact(n: number): string {
  if (!isFinite(n)) return "-";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

export function shortKey(k: string, n = 4): string {
  if (!k) return "";
  return `${k.slice(0, n)}…${k.slice(-n)}`;
}

// The MagicBlock ER endpoint (matches ENDPOINTS.er) so ER txs link to the right cluster.
const ER_RPC = process.env.NEXT_PUBLIC_ER_URL || "https://devnet.magicblock.app";

// Solana Explorer link for a base-layer (devnet L1) transaction — deposits, delegation, withdrawals.
export function baseTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// Solana Explorer link for a MagicBlock ER transaction (open/close trades run on the ER, so they
// must be viewed against the ER RPC via the explorer's custom-cluster mode).
export function erTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(ER_RPC)}`;
}
