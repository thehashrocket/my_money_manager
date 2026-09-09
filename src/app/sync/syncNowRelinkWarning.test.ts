import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How `syncNowAction` renders the one outcome `verifyStagedLinks` made
 * reachable: `status: "synced"` with `insertedCount: 0` and a warning.
 *
 * Before the guard, `synced` implied at least one row — the `up-to-date` early
 * return covered the empty case — so "Imported 0 transactions" was
 * unreachable. It is now the correct summary for a sync whose every account
 * was re-linked mid-flight, and the warning is the ONLY thing distinguishing
 * it from a wasted click. CLAUDE.md's `/sync` contract is that a sync carrying
 * warnings is never a plain success, and `ok()` is what enforces it by
 * promoting to `status: "warning"` — assert the promotion, not just the text.
 *
 * `syncSimpleFin` is mocked because its own behaviour is covered against a real
 * schema in `src/lib/simplefin/sync.test.ts` and
 * `src/lib/simplefin/syncRelinkGuard.test.ts`; what is only observable HERE is
 * the wiring from outcome to returned state. `next/cache`'s `revalidatePath`
 * is mocked because it needs a live Next.js request context this test has not
 * got.
 */
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/simplefin/link", () => ({
  setAccountLink: vi.fn(),
}));

vi.mock("@/lib/simplefin/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/simplefin/sync")>()),
  syncSimpleFin: vi.fn(),
}));

const { revalidatePath } = await import("next/cache");
const { syncSimpleFin } = await import("@/lib/simplefin/sync");
const { syncNowAction } = await import("./actions");

const RELINK_WARNING =
  '"Checking" was re-linked to a different bank account while the sync was running, so its ' +
  "transactions were not imported. Nothing was written for it — sync again to import them " +
  "against the current link.";

type SyncOutcome = Awaited<ReturnType<typeof syncSimpleFin>>;

function syncedOutcome(overrides: Partial<Extract<SyncOutcome, { status: "synced" }>>) {
  return {
    status: "synced",
    batchId: 7,
    insertedCount: 0,
    pairsLinked: 0,
    ambiguous: [],
    snapshot: {
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      prunedPaths: [],
      consistent: true,
      degradedReason: null,
    },
    accounts: [],
    balanceUpdates: [],
    warnings: [],
    ...overrides,
  } as SyncOutcome;
}

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(syncSimpleFin).mockReset();
});

describe("syncNowAction — a relink-emptied sync is a warning, not a plain success", () => {
  it("promotes to status warning and carries the guard's sentence verbatim", async () => {
    vi.mocked(syncSimpleFin).mockResolvedValue(
      syncedOutcome({ insertedCount: 0, warnings: [RELINK_WARNING] }),
    );

    const state = await syncNowAction();

    // NOT "ok": the user clicked Sync, the batch committed, and nothing landed.
    // A green tick here is the failure this whole guard exists to avoid.
    expect(state.status).toBe("warning");
    if (state.status !== "warning") throw new Error("unreachable");
    expect(state.warnings).toContain(RELINK_WARNING);
    // Plural, and honest about the count actually written.
    expect(state.message).toContain("Imported 0 transactions");
  });

  it("still revalidates — the batch row committed even though it holds nothing", async () => {
    // This is NOT one of the four refuse-before-refresh cases: `verifyStagedLinks`
    // drops rows INSIDE a transaction that still writes an `import_batches` row,
    // so /sync and /import both have new state to show and skipping the refresh
    // would leave the undo button pointing at a batch the page never learned about.
    vi.mocked(syncSimpleFin).mockResolvedValue(
      syncedOutcome({ insertedCount: 0, warnings: [RELINK_WARNING] }),
    );

    await syncNowAction();

    expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
  });

  it("keeps the singular/plural agreement when the guard dropped all but one row", async () => {
    vi.mocked(syncSimpleFin).mockResolvedValue(
      syncedOutcome({ insertedCount: 1, warnings: [RELINK_WARNING] }),
    );

    const state = await syncNowAction();

    expect(state.status).toBe("warning");
    if (state.status !== "warning") throw new Error("unreachable");
    expect(state.message).toContain("Imported 1 transaction,");
    expect(state.message).not.toContain("1 transactions");
  });

  it("reports plain ok only when the sync wrote rows AND raised nothing", async () => {
    // The complement, so the promotion above is shown to be caused by the
    // warning rather than by anything else in this outcome shape.
    vi.mocked(syncSimpleFin).mockResolvedValue(
      syncedOutcome({ insertedCount: 2, warnings: [] }),
    );

    const state = await syncNowAction();

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.message).toBe("Imported 2 transactions, linked 0 transfer pairs.");
  });
});
