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

vi.mock("@/lib/simplefin/sync", () => ({
  syncSimpleFin: vi.fn(),
  linkTransferPairManually: linkTransferPairManuallyMock,
  unlinkTransferPair: vi.fn(),
}));

const { revalidatePath } = await import("next/cache");

const {
  linkAccountAction,
  resolveTransferAction,
  resolveSameAccountReversalAction,
} = await import("./actions");

beforeEach(() => {
  setAccountLinkMock.mockReset();
  linkTransferPairManuallyMock.mockReset();
  vi.mocked(revalidatePath).mockClear();
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
    setAccountLinkMock.mockReturnValue({ warning: "5 previously-imported transactions carry no SimpleFIN de-dup tag." });

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
    setAccountLinkMock.mockReturnValue({ warning: null });

    const state = await linkAccountAction(
      { status: "idle" },
      formData({ accountId: "1", simplefinAccountId: "ACT-abc123" }),
    );

    expect(state.status).toBe("ok");
    if (state.status !== "ok") throw new Error("unreachable");
    expect(state.warnings).toEqual([]);
  });
});

describe("resolve actions — the same-account opt-in is carried by WHICH action ran", () => {
  it("resolveSameAccountReversalAction passes allowSameAccountReversal", () => {
    linkTransferPairManuallyMock.mockReturnValue(undefined);

    return resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300" }),
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
    linkTransferPairManuallyMock.mockReturnValue(undefined);

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
    linkTransferPairManuallyMock.mockReturnValue(undefined);

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
      formData({ aId: "1299", bId: "1300" }),
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
      formData({ aId: "1", bId: "2" }),
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
    linkTransferPairManuallyMock.mockReturnValue(undefined);

    const state = await resolveSameAccountReversalAction(
      { status: "idle" },
      formData({ aId: "1299", bId: "1300" }),
    );

    expect(state.status).toBe("ok");
    const paths = vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(
      expect.arrayContaining(["/sync", "/", "/transactions", "/categorize", "/budget"]),
    );
  });
});
