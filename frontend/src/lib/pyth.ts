// Live USD prices (SOL, ETH, BTC) from Pyth via the official client-side SDK.
// Pyth is built for on- AND off-chain JS/TS apps, so this runs in the browser.
// Docs: https://docs.pyth.network/price-feeds/core/fetch-price-updates
import { HermesClient } from "@pythnetwork/hermes-client";
import { PYTH } from "./constants";

// asset key (e.g. "SOL") -> USD price
export type PythPrices = Record<string, number>;

const client = new HermesClient(PYTH.hermes);
// id(lowercased, no 0x) -> asset key
const ID_TO_ASSET: Record<string, string> = Object.fromEntries(
  Object.entries(PYTH.ids).map(([asset, id]) => [id.toLowerCase(), asset])
);
const IDS = Object.values(PYTH.ids).map((id) => `0x${id}`);

interface ParsedUpdate {
  id: string;
  price: { price: string; expo: number };
}

function readParsed(parsed?: ParsedUpdate[]): PythPrices {
  const out: PythPrices = {};
  for (const p of parsed ?? []) {
    const asset = ID_TO_ASSET[p.id.toLowerCase().replace(/^0x/, "")];
    if (asset) out[asset] = Number(p.price.price) * Math.pow(10, p.price.expo);
  }
  return out;
}

/** One-shot latest price fetch (used to seed and as the 1s poll). */
export async function fetchLatestPyth(): Promise<PythPrices> {
  try {
    const res = await client.getLatestPriceUpdates(IDS, { parsed: true });
    return readParsed(res.parsed as ParsedUpdate[] | undefined);
  } catch {
    return {};
  }
}

/** Subscribe to the live Hermes SSE stream via the official SDK. */
export function subscribePyth(
  onPrices: (p: PythPrices) => void,
  onStatus?: (connected: boolean) => void
): () => void {
  let es: Awaited<ReturnType<HermesClient["getPriceUpdatesStream"]>> | null = null;
  let closed = false;

  client
    .getPriceUpdatesStream(IDS, { parsed: true })
    .then((src) => {
      if (closed) {
        src.close();
        return;
      }
      es = src;
      es.onmessage = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as { parsed?: ParsedUpdate[] };
          const out = readParsed(data.parsed);
          if (Object.keys(out).length) {
            onPrices(out);
            onStatus?.(true);
          }
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => onStatus?.(false);
    })
    .catch(() => onStatus?.(false));

  return () => {
    closed = true;
    es?.close();
  };
}
