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

const { linkAccountAction } = await import("./actions");

beforeEach(() => {
  setAccountLinkMock.mockReset();
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
