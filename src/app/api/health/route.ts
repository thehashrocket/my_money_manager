import { sql } from "drizzle-orm";
import { connection, NextResponse } from "next/server";
import { db } from "@/db";

// Cheap liveness probe for the Compose healthcheck. `/` is not usable as a
// probe: it runs the full dashboard query set including the 6-month trend
// aggregation, which is too heavy to hit every few seconds.
//
// `dynamic = "force-dynamic"` removed under Cache Components
// (cache-components-migration plan, Stage 0) — it errors the build there.
// **`await connection()` replaces it, and is NOT optional the way the old
// comment implied "hits the database fresh either way" would suggest.**
// `db.get(sql...)` below is a plain synchronous better-sqlite3 call, which
// Next's Cache Components validator does not track as dynamic (unlike
// `fetch`/`cookies`/`searchParams`) — verified empirically: without this
// call, `pnpm build`'s route table showed `/api/health` as `○ (Static)`,
// meaning `{ok:true}` would freeze into the build output forever and the
// Docker healthcheck (`compose.yaml`) would report healthy regardless of
// whether the database is actually reachable, exactly the failure mode
// this endpoint exists to catch.
export async function GET() {
  await connection();
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
