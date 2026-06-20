// Loads frontend/.env so CLI scripts pick up the custom devnet RPCs (avoids public-RPC 429s).
// Exposes BASE_RPC (Solana L1) and ER_RPC (MagicBlock ephemeral rollup). Existing process.env wins.
const fs = require("fs"), path = require("path");
try {
  const envPath = path.join(__dirname, "../frontend/.env");
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env — fall back to public endpoints */ }

const BASE_RPC = process.env.SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const ER_RPC = process.env.MAGICBLOCK_DEVNET_RPC_URL || "https://devnet.magicblock.app";
module.exports = { BASE_RPC, ER_RPC };
