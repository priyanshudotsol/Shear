import type { NextRequest } from "next/server";
import { getRecentEvents } from "@/lib/server/trades";

export const runtime = "nodejs"; // Prisma needs the Node runtime
export const dynamic = "force-dynamic"; // always serve live DB state

// GET /api/activity?limit=50 - persistent global feed of the most recent trade events (opens +
// closes + liquidations) across all wallets.
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  return Response.json({ events: await getRecentEvents(limit) });
}
