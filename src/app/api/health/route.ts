import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";

// Cheap liveness probe for the Compose healthcheck. `/` is not usable as a
// probe: it runs the full dashboard query set including the 6-month trend
// aggregation, which is too heavy to hit every few seconds.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    db.get(sql`select 1`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Logged, never returned: the raw driver error can carry filesystem
    // paths or SQLite internals, and this endpoint has no auth in front of
    // it — being loopback-only (compose.yaml) narrows who can reach it, not
    // what's safe to say back to them.
    console.error("Health check failed:", err);
    return NextResponse.json({ ok: false, error: "database unavailable" }, { status: 503 });
  }
}
