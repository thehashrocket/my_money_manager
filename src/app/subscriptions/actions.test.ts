import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/subscriptions`' actions revalidate AFTER a committed `bulkCategorize`.
 *
 * `revalidatePath` throws in this Next build, and it used to run bare here — so
 * the throw escaped the action and rendered `/subscriptions/error.tsx`,
 * discarding the whole per-merchant outcome object on the way out. That object
 * is the load-bearing part: this page has no undo (CLAUDE.md rule 6), so
 * `refusal` / `retargetedRule` are the ONLY record the user ever gets that a
 * hand-trained rule was withheld or silently repointed. These tests pin that a
 * failed refresh downgrades to a warning riding ALONGSIDE that outcome, rather
 * than replacing it with a crash whose copy denies the write happened.
 *
 * `revalidatePath` has to actually THROW here or there is nothing being tested:
 * a bare `vi.fn()` passes with and without the guard. Same lesson
 * `src/app/sync/actions.test.ts` records.
 *
 * `@/db` is mocked rather than spread from the real module: importing it opens
 * the real ledger file. `fileSubscription` / `fileAllSubscriptions` are mocked
 * too — their behavior is covered against a real schema in
 * `src/lib/subscriptions/categorizeSubscriptions.test.ts`; what is only
 * observable HERE is the action's wiring.
 */

const fileSubscriptionMock = vi.hoisted(() => vi.fn());
const fileAllSubscriptionsMock = vi.hoisted(() => vi.fn());
const insertRunMock = vi.hoisted(() => vi.fn());
const deleteRunMock = vi.hoisted(() => vi.fn());

const dbMock = vi.hoisted(() => ({
  // `subscriptionsCategoryId()`'s lookup.
  select: () => ({ from: () => ({ where: () => ({ get: () => ({ id: 7 }) }) }) }),
  insert: () => ({
    values: () => ({ onConflictDoNothing: () => ({ run: insertRunMock }) }),
  }),
  delete: () => ({ where: () => ({ run: deleteRunMock }) }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/db", async () => ({
  db: dbMock,
  schema: await import("@/db/schema"),
}));

// Spread the real module rather than hand-listing: a hand-listed factory
// silently omits whatever gets added to it next.
vi.mock("@/lib/subscriptions/categorizeSubscriptions", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/subscriptions/categorizeSubscriptions")
  >()),
  fileSubscription: fileSubscriptionMock,
  fileAllSubscriptions: fileAllSubscriptionsMock,
}));

const { revalidatePath } = await import("next/cache");
const {
  categorizeAllSubscriptionsAction,
  categorizeSubscriptionAction,
  dismissSubscriptionAction,
  restoreSubscriptionAction,
} = await import("./actions");

/** The outcome the page cannot afford to lose: a rule was repointed, no undo. */
const RETARGET_OUTCOME = {
  normalizedMerchant: "NETFLIX",
  filedCount: 3,
  refusal: "No rule was saved for “NETFLIX”.",
  retargetedRule:
    'The existing rule for "NETFLIX" now files it under Subscriptions instead of Entertainment.',
};

const REFRESH_WARNING =
  "Your change was saved, but this page couldn't refresh — reload to see the current state.";

function formData(merchant: string): FormData {
  const fd = new FormData();
  fd.set("normalizedMerchant", merchant);
  return fd;
}

function makeRefreshThrow(): () => void {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(revalidatePath).mockImplementation(() => {
    throw new Error("revalidatePath blew up");
  });
  return () => logged.mockRestore();
}

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  fileSubscriptionMock.mockReset();
  fileAllSubscriptionsMock.mockReset();
  insertRunMock.mockReset();
  deleteRunMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("categorizeSubscriptionAction", () => {
  it("carries no warning when the refresh succeeds", async () => {
    fileSubscriptionMock.mockReturnValue(RETARGET_OUTCOME);

    const outcome = await categorizeSubscriptionAction(formData("NETFLIX"));

    expect(outcome.warning).toBeUndefined();
    expect(outcome.retargetedRule).toBe(RETARGET_OUTCOME.retargetedRule);
  });

  it("keeps the per-merchant outcome when the refresh throws", async () => {
    fileSubscriptionMock.mockReturnValue(RETARGET_OUTCOME);
    const restore = makeRefreshThrow();

    // Not a throw. A throw here lands in `/subscriptions/error.tsx`, which
    // says nothing was written — false, and it takes the retarget notice with
    // it. There is no other surface anywhere in the app that reports one.
    const outcome = await categorizeSubscriptionAction(formData("NETFLIX"));
    restore();

    expect(outcome.filedCount).toBe(3);
    expect(outcome.refusal).toBe(RETARGET_OUTCOME.refusal);
    expect(outcome.retargetedRule).toBe(RETARGET_OUTCOME.retargetedRule);
    expect(outcome.warning).toBe(REFRESH_WARNING);
  });

  it("does not swallow the refresh failure silently", async () => {
    // The developer-facing half. A failing `revalidatePath` is a bug in this
    // app, not a user error, and the returned warning is aimed at someone who
    // cannot act on it.
    fileSubscriptionMock.mockReturnValue(RETARGET_OUTCOME);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });

    await categorizeSubscriptionAction(formData("NETFLIX"));

    expect(logged).toHaveBeenCalledWith(
      "[/subscriptions] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });
});

describe("categorizeAllSubscriptionsAction", () => {
  it("keeps every merchant's outcome when the refresh throws", async () => {
    // The sweep is the worse case: one click can withhold or repoint a rule
    // per merchant, and a crash here discards all of them at once.
    const sweep = {
      merchantsFiled: 2,
      filedCount: 9,
      refusals: [RETARGET_OUTCOME],
      retargets: [RETARGET_OUTCOME],
      failures: [],
    };
    fileAllSubscriptionsMock.mockReturnValue(sweep);
    const restore = makeRefreshThrow();

    const outcome = await categorizeAllSubscriptionsAction();
    restore();

    expect(outcome.filedCount).toBe(9);
    expect(outcome.refusals).toEqual([RETARGET_OUTCOME]);
    expect(outcome.retargets).toEqual([RETARGET_OUTCOME]);
    expect(outcome.warning).toBe(REFRESH_WARNING);
  });
});

describe("dismissSubscriptionAction", () => {
  it("reports a committed dismissal as saved when the refresh throws", async () => {
    const restore = makeRefreshThrow();

    const outcome = await dismissSubscriptionAction(formData("NETFLIX"));
    restore();

    // The row IS written; only the refresh failed.
    expect(insertRunMock).toHaveBeenCalled();
    expect(outcome.warning).toBe(REFRESH_WARNING);
  });
});

/**
 * The RESTORE half, which had no coverage at all.
 *
 * It is not a redundant copy of the dismiss case above. v0.26.0 turned both
 * buttons from plain `<form action={serverAction}>` submits into one client
 * island (`DismissSubscriptionButton`) that picks the action from a `mode`
 * prop — so `restoreSubscriptionAction` became reachable through a code path
 * that did not exist before, and it is the only route on this page back from a
 * dismissal. A dismissal is a STANDING instruction (rule 10 preserves the
 * oldest one on a backfill collision), so a restore that appears not to have
 * worked is a subscription the user has now permanently hidden by accident.
 */
describe("restoreSubscriptionAction", () => {
  it("deletes the dismissal and reports it as saved when the refresh throws", async () => {
    const restore = makeRefreshThrow();

    const outcome = await restoreSubscriptionAction(formData("NETFLIX"));
    restore();

    // The delete landed; only the page is stale. A throw here would render
    // `/subscriptions/error.tsx`, whose copy denies the write happened — and
    // the row is still on the dismissed list either way, so the user's only
    // evidence agrees with the false message.
    expect(deleteRunMock).toHaveBeenCalled();
    expect(outcome.warning).toBe(REFRESH_WARNING);
  });
});
