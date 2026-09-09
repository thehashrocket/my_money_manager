import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `linkAccountAction` used to discard `setAccountLink`'s return value
 * entirely -- the warning `setAccountLink` computes (see
 * src/lib/simplefin/link.ts) never reached the user. That bug is fixed on
 * this branch; this test guards the wiring itself (the
 * `result.warning ? [result.warning] : []` forwarding in
 * src/app/sync/actions.ts) so a future refactor can't silently reintroduce
 * it. `setAccountLink` itself is mocked -- its own behavior is covered by
 * src/lib/simplefin/link.test.ts -- and `next/cache`'s `revalidatePath`
 * is mocked because it requires a live Next.js request context this test
 * doesn't have.
 */
const setAccountLinkMock = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/simplefin/link", () => ({
  setAccountLink: setAccountLinkMock,
}));

/**
 * `linkTransferPairManually` is mocked so these tests can assert the ARGUMENTS
 * the two resolve actions pass it. Its own behavior (the same-account guard,
 * the same-day guard, the sign and magnitude checks) is covered against a real
 * schema in src/lib/simplefin/sync.test.ts. What is only observable HERE is
 * which action carries the same-account opt-in — the whole reason there are two
 * actions instead of one action with a form field.
 */
const linkTransferPairManuallyMock = vi.hoisted(() => vi.fn());
const rejectTransferPairManuallyMock = vi.hoisted(() => vi.fn());
const unlinkTransferPairMock = vi.hoisted(() => vi.fn());
const undoSyncBatchMock = vi.hoisted(() => vi.fn());

// Spread the real module for the same reason the sync mock below does: a
// hand-listed factory silently omits whatever gets added next.
vi.mock("@/lib/simplefin/undoSync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/simplefin/undoSync")>()),
  undoSyncBatch: undoSyncBatchMock,
}));

// Spreads the REAL module rather than hand-listing its exports. The hand-listed
// version silently omitted `rejectTransferPairManually` when it was added, so
// the "Not a reversal" branch could not be tested at all — the first test
// written for it failed with "No export is defined on the mock" rather than an
// assertion, which reads as a broken test rather than a missing one. Adding an
// export to the real module can no longer leave this factory behind.
vi.mock("@/lib/simplefin/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/simplefin/sync")>()),
  syncSimpleFin: vi.fn(),
  linkTransferPairManually: linkTransferPairManuallyMock,
  rejectTransferPairManually: rejectTransferPairManuallyMock,
  unlinkTransferPair: unlinkTransferPairMock,
}));

const { revalidatePath } = await import("next/cache");

const {
  linkAccountAction,
  resolveTransferAction,
  resolveSameAccountReversalAction,
  unlinkTransferAction,
  undoSyncAction,
} = await import("./actions");

beforeEach(() => {
  setAccountLinkMock.mockReset();
  linkTransferPairManuallyMock.mockReset();
  rejectTransferPairManuallyMock.mockReset();
  rejectTransferPairManuallyMock.mockReturnValue("recorded");
  unlinkTransferPairMock.mockReset();
  unlinkTransferPairMock.mockReturnValue("unlinked");
  undoSyncBatchMock.mockReset();
  undoSyncBatchMock.mockReturnValue({ status: "undone", batchId: 3, deletedCount: 2 });
  // mockRESET, not mockClear: the refresh-failure tests below install a
  // throwing implementation, and `mockClear` only wipes call history. Leaving
  // the implementation in place would make every later test in this file
  // revalidate into an exception.
  vi.mocked(revalidatePath).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("linkAccountAction — warning forwarding", () => {
  it("forwards setAccountLink's warning into the returned state", async () => {
    setAccountLinkMock.mockReturnValue({
      warning: "5 previously-imported transactions carry no SimpleFIN de-dup tag.",
      linkChanged: true,
    });

    const state = await linkAccountAction(
      { status: "idle" },
      formData({ accountId: "1", simplefinAccountId: "ACT-abc123" }),
    );

    expect(state.status).toBe("warning");
    if (state.status !== "warning") throw new Error("unreachable");
    expect(state.warnings).toEqual([
      "5 previously-imported transactions carry no SimpleFIN de-dup tag.",
    ]);
  });

  it("reports plain success with no warnings when setAccountLink returns none", async () => {
    setAccountLinkMock.mockReturnValue({ warning: null, linkChanged: true });

    const state = await linkAccountAction(
      { status: "idle" },
      formData({ accountId: "1", simplefinAccountId: "ACT-abc123" }),
    );

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warnings).toEqual([]);
  });

  /**
   * A re-save that moved nothing does not claim to have linked anything.
   *
   * `setAccountLink` has always computed `linkChanged` — it gates both of its
   * warnings on it — and until v0.22.0 discarded it, so saving the value an
   * account already held reported "Account linked — it will be included in the
   * next sync." Reachable by double-clicking Save or from a second tab. Last of
   * the four no-op-reads-as-success paths in this file.
   */
  it("does not claim a link it did not make", async () => {
    setAccountLinkMock.mockReturnValue({ warning: null, linkChanged: false });

    const state = await linkAccountAction(
      { status: "idle" },
      formData({ accountId: "1", simplefinAccountId: "ACT-abc123" }),
    );

    // `ok`, not `error`: unlike `nothing-to-undo` and `already-unpaired`, no
    // durable fact the user asked for is missing here — the end state is
    // exactly what they wanted, it just already held.
    expect(state.status).toBe("ok");
    expect(state.status !== "idle" && state.message).toMatch(/already linked/i);
    expect(state.status !== "idle" && state.message).not.toMatch(
      /will be included in the next sync/i,
    );
  });

  it("says 'already unlinked' rather than 'unlinked' for a no-op unlink", async () => {
    setAccountLinkMock.mockReturnValue({ warning: null, linkChanged: false });

    const state = await linkAccountAction(
      { status: "idle" },
      formData({ accountId: "1", simplefinAccountId: "" }),
    );

    expect(state.status).toBe("ok");
    expect(state.status !== "idle" && state.message).toMatch(/already unlinked/i);
  });
});

describe("syncNowAction — a refusal must not revalidate first", () => {
  it("does not revalidate when no accounts are linked", async () => {
    // `syncSimpleFin` returns this status before it writes anything, so there
    // is nothing to refresh. This was the THIRD revalidate-before-fail in this
    // file and the one the earlier fixes missed; it is latent rather than live
    // only because `SyncButton` never unmounts, so it does not lose its own
    // refusal the way the undo and unlink forms did.
    const { syncSimpleFin } = await import("@/lib/simplefin/sync");
    vi.mocked(syncSimpleFin).mockResolvedValue({
      status: "no-linked-accounts",
    } as Awaited<ReturnType<typeof syncSimpleFin>>);

    const { syncNowAction } = await import("./actions");
    const state = await syncNowAction();

    expect(state.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("resolve actions — the same-account opt-in is carried by WHICH action ran", () => {
  it("resolveSameAccountReversalAction passes allowSameAccountReversal", () => {
    linkTransferPairManuallyMock.mockReturnValue({ clearedRejection: false });

    return resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300", intent: "link" }),
    ).then((state) => {
      expect(state.status).toBe("ok");
      expect(linkTransferPairManuallyMock).toHaveBeenCalledWith(1299, 1300, undefined, {
        allowSameAccountReversal: true,
      });
    });
  });

  it("resolveTransferAction does NOT pass it, so the ordinary queue can never link a same-account pair", () => {
    // The security property in the docstring: the opt-in is an action
    // argument, never form data. If this ever regressed, the cross-account
    // review queue would silently gain the power to pair two rows on one
    // account — the exact shape that is ~13% coincidence on real data.
    linkTransferPairManuallyMock.mockReturnValue({ clearedRejection: false });

    return resolveTransferAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300" }),
    ).then((state) => {
      expect(state.status).toBe("ok");
      expect(linkTransferPairManuallyMock).toHaveBeenCalledWith(1299, 1300);
      const opts = linkTransferPairManuallyMock.mock.calls[0][3];
      expect(opts).toBeUndefined();
    });
  });

  it("ignores an allowSameAccountReversal field smuggled into the ordinary form", () => {
    // A crafted or stale POST is the threat model, and FormData is the only
    // thing an attacker controls. `validateResolveTransferInput` parses to
    // {aId, bId}, so an extra field can never reach the call.
    linkTransferPairManuallyMock.mockReturnValue({ clearedRejection: false });

    return resolveTransferAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300", allowSameAccountReversal: "true" }),
    ).then(() => {
      expect(linkTransferPairManuallyMock.mock.calls[0][3]).toBeUndefined();
    });
  });
});

describe("resolveSameAccountReversalAction — failures come back as state, never as a throw", () => {
  it("reports the stale-tab race instead of crashing the page", async () => {
    // Two tabs open on /sync is ordinary use. A throw here has no error
    // boundary to land in and would take the undo button and the remaining
    // buckets down with it (see the SyncActionState docstring).
    linkTransferPairManuallyMock.mockImplementation(() => {
      throw new Error("Both transactions must exist.");
    });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300", intent: "link" }),
    );

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/Both transactions must exist/);
    // A failed link must not tell every page its data changed.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("surfaces the underlying guard when the two rows turn out not to be same-day", async () => {
    linkTransferPairManuallyMock.mockImplementation(() => {
      throw new Error("A same-account reversal must be same-day.");
    });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "1", bId: "2", intent: "link" }),
    );

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/same-day/);
  });

  it("rejects a form that names the same row twice, without touching the database", async () => {
    // Reachable: both selects default to the same row if a bucket ever renders
    // one candidate on each side wrong, and it is the cheapest crafted POST.
    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "7" }),
    );

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.message).toMatch(/Invalid reversal pairing/);
    expect(linkTransferPairManuallyMock).not.toHaveBeenCalled();
  });

  it("rejects a submission with no selection made (the “Choose…” placeholder)", async () => {
    // The placeholder option posts "", which `required` normally blocks — but
    // a resubmitted or scripted POST is not bound by client-side `required`.
    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "", bId: "1300" }),
    );

    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(linkTransferPairManuallyMock).not.toHaveBeenCalled();
  });

  it("revalidates every affected page on success, so a linked reversal leaves the spending surfaces", async () => {
    linkTransferPairManuallyMock.mockReturnValue({ clearedRejection: false });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300", intent: "link" }),
    );

    expect(state.status).toBe("ok");
    const paths = vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["/sync", "/", "/transactions", "/categorize", "/budget"]),
    );
  });
});

/**
 * The "Not a reversal" branch. Until v0.19.0 this had NO action-layer coverage
 * — swapping the two success messages passed the whole suite — and the module
 * mock above could not even express it.
 *
 * It matters more than the link branch, not less: linking is undoable from the
 * "Linked pairs" list, while a rejection is durable, has no UI to undo it, and
 * suppresses the automatic matchers for that pair permanently.
 */
describe("resolveSameAccountReversalAction — the reject branch", () => {
  it("rejects rather than links when intent=reject", async () => {
    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "reject" }),
    );

    expect(rejectTransferPairManuallyMock).toHaveBeenCalledWith(7, 9);
    expect(linkTransferPairManuallyMock).not.toHaveBeenCalled();
    expect(state.status).toBe("ok");
    expect(state.status !== "idle" && state.message).toMatch(/not a reversal/i);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("distinguishes a fresh rejection from one that was already recorded", async () => {
    rejectTransferPairManuallyMock.mockReturnValue("already-rejected");

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "reject" }),
    );

    // A no-op must not claim to have recorded something. Same reasoning as
    // undoSyncAction's nothing-to-undo branch.
    expect(state.status !== "idle" && state.message).toMatch(/already/i);
  });

  it("surfaces a refusal from the store as error state, never a throw", async () => {
    rejectTransferPairManuallyMock.mockImplementation(() => {
      throw new Error("One of these transactions is already paired");
    });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "reject" }),
    );

    expect(state.status).toBe("error");
    // A failed action must not revalidate: that unmounts the form holding the
    // message the user needs to read.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  // An out-of-enum intent lands in NEITHER branch. Asserted unconditionally:
  // an earlier version let `state.status === "error"` short-circuit the
  // assertions, so it passed whether the schema refused the value or silently
  // defaulted it — it could not have caught the defaulting it was written for.
  it.each(["rejec", "", "REJECT", "Link", "delete"])(
    "refuses intent=%p outright rather than falling into either branch",
    async (intent) => {
      const state = await resolveSameAccountReversalAction(
        { status: "idle" },
        formData({ aId: "7", bId: "9", intent }),
      );

      expect(state.status).toBe("error");
      expect(linkTransferPairManuallyMock).not.toHaveBeenCalled();
      expect(rejectTransferPairManuallyMock).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("links on an explicit intent=link, and SAYS it linked", async () => {
    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "link" }),
    );

    expect(linkTransferPairManuallyMock).toHaveBeenCalledWith(7, 9, undefined, {
      allowSameAccountReversal: true,
    });
    expect(rejectTransferPairManuallyMock).not.toHaveBeenCalled();

    // The message assertion is not decoration. This describe block's own
    // docstring says swapping the two success messages used to pass the whole
    // suite; that was fixed for the REJECT branch only, so replacing this
    // branch's copy with the rejection copy still passed 48/48 until v0.22.0.
    // The two branches have opposite effects on money — a link removes both
    // rows from every spending surface, a rejection deliberately leaves them in
    // it — so a user shown the wrong copy believes their totals are intact
    // while two rows have just left them, with nothing on the page to correct
    // it.
    expect(state.status).toBe("ok");
    expect(state.status !== "idle" && state.message).toMatch(
      /linked as a reversal/i,
    );
    expect(state.status !== "idle" && state.message).not.toMatch(/not a reversal/i);
  });

  it("REFUSES when intent is absent entirely — it does not fall back to link", async () => {
    // The regression this pins is a money one. While the schema defaulted a
    // missing `intent` to "link", any submit path that lost the clicked
    // submitter's field ran `linkTransferPairManually` with the same-account
    // opt-in — removing both rows from every spending surface and reporting
    // success, which is exactly what CLAUDE.md rule 4 forbids. Absence is now
    // a refusal.
    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9" }),
    );

    expect(state.status).toBe("error");
    expect(linkTransferPairManuallyMock).not.toHaveBeenCalled();
    expect(rejectTransferPairManuallyMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates the reject branch after the write, not skipped", async () => {
    rejectTransferPairManuallyMock.mockReturnValue("recorded");

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "reject" }),
    );

    expect(state.status).toBe("ok");
    expect(revalidatePath).toHaveBeenCalledWith("/sync");
  });

  /**
   * A COMMITTED write whose refresh then fails is still a committed write.
   *
   * This replaces a test that claimed to pin the same property and could not:
   * it asserted `status === "ok"` with `revalidatePath` mocked as a bare
   * `vi.fn()` that never throws, so both orderings passed it and restoring the
   * pre-v0.22.0 structure (revalidate INSIDE the try) left the suite green. The
   * mock has to throw or there is nothing being tested.
   *
   * Making it throw also showed the fix had been half-done. Moving
   * `revalidateAll()` out of the `try` stopped the commit being reported as a
   * refusal, but the throw then escaped the action entirely and landed in
   * `src/app/sync/error.tsx`, whose copy says "Nothing was imported. Your
   * ledger is unchanged" — an affirmative promise that is false once the
   * `transfer_pair_rejections` row exists, and a rejection has no UI to undo it.
   * `guardRefresh` catches it and downgrades the outcome to a warning instead.
   */
  it("reports a COMMITTED rejection as a success even when the refresh throws", async () => {
    rejectTransferPairManuallyMock.mockReturnValue("recorded");
    // Silenced, not asserted, here — the logging itself is the next test.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "reject" }),
    );
    logged.mockRestore();

    // Not a throw (which would hit error.tsx and promise the opposite), and
    // not an error state (which would deny a write that happened).
    expect(state.status).toBe("warning");
    if (state.status !== "warning") throw new Error("unreachable");
    expect(state.message).toMatch(/not a reversal/i);
    expect(state.warnings).toEqual([
      "Your change was saved, but this page couldn't refresh — reload to see the current state.",
    ]);
  });

  it("does not swallow the refresh failure silently", async () => {
    // The user-facing half is above; this is the developer-facing half. A
    // failing `revalidatePath` is a bug in this app, not a user error, and
    // nothing else on /sync records one.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "reject" }),
    );

    expect(logged).toHaveBeenCalledWith(
      "[/sync] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("says so when linking ERASES a rejection the user had recorded", async () => {
    // The link path calls `clearPairRejection` unconditionally, so this click
    // destroys a durable decision with no way back. On a multi-candidate bucket
    // the card is byte-identical before and after a rejection, so without this
    // sentence the user has no way to know the answer they gave earlier is
    // gone. CLAUDE.md rule 4 cites exactly this as why link is not the
    // "reversible" branch and so was never a safe default for `intent`.
    linkTransferPairManuallyMock.mockReturnValue({ clearedRejection: true });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "link" }),
    );

    expect(state.status).toBe("ok");
    expect(state.status !== "idle" && state.message).toMatch(/linked as a reversal/i);
    expect(state.status !== "idle" && state.message).toMatch(
      /cleared the .not a reversal./i,
    );
  });

  it("stays silent about an erasure that did not happen", async () => {
    linkTransferPairManuallyMock.mockReturnValue({ clearedRejection: false });

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "7", bId: "9", intent: "link" }),
    );

    expect(state.status !== "idle" && state.message).not.toMatch(/cleared/i);
  });
});

describe("unlinkTransferAction — a no-op is not a success", () => {
  it("reports an unlink that actually happened as ok", async () => {
    const state = await unlinkTransferAction({ status: "idle" }, formData({ id: "4" }));
    expect(state.status).toBe("ok");
  });

  it("refuses to claim a correction it did not record", async () => {
    // `unlinkTransferPair` returns early when the row is already unpaired, and
    // that path writes NO rejection — so the ordinary success copy would be
    // asserting a durable "not a transfer" that does not exist. Reachable via
    // undoSyncBatch clearing a survivor's transferPairId under a stale tab.
    unlinkTransferPairMock.mockReturnValue("already-unpaired");

    const state = await unlinkTransferAction({ status: "idle" }, formData({ id: "4" }));

    expect(state.status).toBe("error");
    expect(state.status !== "idle" && state.message).toMatch(/already unpaired/i);
  });

  it("does NOT revalidate on the no-op refusal — that would unmount the message", async () => {
    // The refusal used to be checked AFTER `revalidateAll()`. Revalidating
    // re-renders `page.tsx`'s "Linked pairs" list, this pair's `<li>` is the
    // only thing rendering `ActionForm`'s inline `role="alert"`, and
    // `unlinkTransferAction` is not an `announceSuccess` failure path — so the
    // one place this sentence is ever shown was being destroyed by the same
    // call that failed. `ActionForm`'s contract is "a failure skips
    // revalidateAll(), so the form is still on screen"; this used to be one of
    // exactly two places that broke it, and nothing asserted the ordering.
    unlinkTransferPairMock.mockReturnValue("already-unpaired");

    await unlinkTransferAction({ status: "idle" }, formData({ id: "4" }));

    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("still revalidates when the unlink actually happened", async () => {
    // The other half of the reorder: moving the guard above `revalidateAll()`
    // must not cost the success path its refresh, or two rows would silently
    // stay out of every spending total until the user reloaded.
    await unlinkTransferAction({ status: "idle" }, formData({ id: "4" }));

    const paths = vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["/sync", "/", "/transactions", "/categorize", "/budget"]),
    );
  });
});

/**
 * `undoSyncAction` had no action-layer coverage at all until the ordering fix
 * below needed pinning. `undoSyncBatch`'s own behaviour (the newest-batch
 * staleness re-check, the row deletion) is covered against a real schema in
 * src/lib/simplefin/undoSync.test.ts; what is only observable HERE is which of
 * its three outcomes revalidates.
 */
describe("undoSyncAction — a refusal must not revalidate the form away", () => {
  it("reports a successful undo and revalidates every affected page", async () => {
    const state = await undoSyncAction({ status: "idle" }, formData({ batchId: "3" }));

    expect(undoSyncBatchMock).toHaveBeenCalledWith(3);
    expect(state.status).toBe("ok");
    expect(state.status !== "idle" && state.message).toMatch(/removed 2 transactions/);
    const paths = vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["/sync", "/", "/transactions", "/categorize", "/budget"]),
    );
  });

  it("does NOT revalidate a nothing-to-undo refusal", async () => {
    // Reachable by double-clicking, or from a second tab that undid it first.
    // The undo form is gated on `lastBatch`, so revalidating on a path that
    // deleted NOTHING re-renders that section out from under the alert — and
    // when an older batch remains, the unkeyed form is REUSED and the message
    // reappears under a different batch's description, which reads as true.
    undoSyncBatchMock.mockReturnValue({ status: "nothing-to-undo" });

    const state = await undoSyncAction({ status: "idle" }, formData({ batchId: "3" }));

    expect(state.status).toBe("error");
    expect(state.status !== "idle" && state.message).toMatch(/already been undone/i);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("does NOT revalidate a stale refusal, and surfaces the store's own reason", async () => {
    // Rule 5: the undo is only offered while the sync batch is still the newest
    // import_batches row of any source, because a later CSV import can
    // content-match against a row this batch inserted. Nothing was deleted, so
    // nothing should be refreshed.
    undoSyncBatchMock.mockReturnValue({
      status: "stale",
      reason: "A CSV import has happened since this sync — undo is no longer safe.",
    });

    const state = await undoSyncAction({ status: "idle" }, formData({ batchId: "3" }));

    expect(state.status).toBe("error");
    expect(state.status !== "idle" && state.message).toMatch(/no longer safe/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a malformed batch id without touching the store", async () => {
    const state = await undoSyncAction({ status: "idle" }, formData({ batchId: "0" }));

    expect(state.status).toBe("error");
    expect(undoSyncBatchMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a throw from the store as state rather than crashing the page", async () => {
    undoSyncBatchMock.mockImplementation(() => {
      throw new Error("database is locked");
    });

    const state = await undoSyncAction({ status: "idle" }, formData({ batchId: "3" }));

    expect(state.status).toBe("error");
    expect(state.status !== "idle" && state.message).toMatch(/database is locked/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
