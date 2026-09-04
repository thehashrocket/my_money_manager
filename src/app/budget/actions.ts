"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { validateAllocateInput } from "@/lib/budget/validateAllocateInput";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
  upsertAllocation,
} from "@/lib/budget/upsertAllocation";
import type { EffectiveAllocation } from "@/lib/budget";
import { AmountParseError, parseAmountToCents } from "@/lib/money";
import {
  CategoryKindChangeRefusedError,
  ProtectedCategoryKindError,
  setCategoryKind,
} from "@/lib/budget/setCategoryKind";
import { copyPreviousMonth, type CopyPreviousMonthResult } from "@/lib/budget/copyMonth";
import {
  createCategory,
  createCategoryGroup,
  moveCategory,
  renameCategory,
  setCarryoverPolicy,
  type CreatedCategory,
  type MoveCategoryResult,
  type MoveDirection,
} from "@/lib/budget/manageCategories";
import { archiveCategory, unarchiveCategory } from "@/lib/budget/archiveCategory";
import {
  CategoryArchiveRefusedError,
  CategoryHasChildrenError,
  CategoryNameTakenError,
  UncategorizedArchiveError,
} from "@/lib/categoryErrors";

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
}

/**
 * Create or update a single leaf category's allocation for a given month.
 *
 * Thin wrapper around `validateAllocateInput` (pure) + `upsertAllocation`
 * (DB-bound): parse FormData → validate shape → run upsert + forward
 * invalidation in a transaction → revalidate → redirect. Follows the
 * redirect-outside-try/catch pattern from `src/app/import/actions.ts`.
 *
 * Validation failures, unknown categories, and parent-category rejects
 * throw `Error`; Next.js renders them via the route's `error.tsx`.
 */
export async function upsertBudgetAllocationAction(
  formData: FormData,
): Promise<void> {
  const raw: Record<string, FormDataEntryValue> = Object.fromEntries(formData);
  // UX: inline form submits dollars (e.g. "40.00"); storage unit is cents.
  // Convert before validation if the caller didn't already provide cents.
  // C4: parseAmountToCents (string math, $/,  stripping) replaces
  // `Math.round(Number(dollars) * 100)`, which CLAUDE.md rule 1 bans — the
  // same binary-float risk `parseFloat(x) * 100` has.
  if (raw.allocatedCents === undefined && raw.allocatedDollars !== undefined) {
    try {
      const dollars = String(raw.allocatedDollars);
      raw.allocatedCents = String(parseAmountToCents(dollars));
    } catch (err) {
      if (!(err instanceof AmountParseError)) throw err;
      // Leave allocatedCents unset; validateAllocateInput's zod schema
      // rejects the missing field with a coherent error message below.
    }
    delete raw.allocatedDollars;
  }

  const parsed = validateAllocateInput(raw);
  if (!parsed.success) {
    throw new Error(`Invalid allocation input — ${formatZodIssues(parsed.error)}`);
  }

  upsertAllocation(db, parsed.data);

  const { year, month } = parsed.data;
  revalidatePath("/budget");
  // Pattern form, not the literal path: `upsertAllocation`'s rollover
  // invalidation can touch every month forward of this one, and the literal
  // form only ever revalidates the one month just submitted.
  revalidatePath("/budget/[year]/[month]", "page");
  redirect(`/budget/${year}/${month}`);
}

const setCategoryKindInputSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  kind: z.enum(["income", "expense", "fund"]),
});

/**
 * A7: returns state instead of throwing. DS32's confirmation dialog renders
 * a refusal inline (with the same category the user was looking at, still
 * open) rather than losing that context to `error.tsx` — that boundary
 * stays as the backstop for anything genuinely unexpected, same posture as
 * `/sync`'s actions.
 */
export type SetCategoryKindActionState =
  | { status: "idle" }
  | { status: "ok"; categoryId: number }
  | { status: "error"; message: string };

export async function setCategoryKindAction(
  _prev: SetCategoryKindActionState,
  formData: FormData,
): Promise<SetCategoryKindActionState> {
  const parsed = setCategoryKindInputSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", message: `Invalid reclassify request — ${formatZodIssues(parsed.error)}` };
  }

  try {
    setCategoryKind(db, parsed.data.categoryId, parsed.data.kind);
  } catch (err) {
    // Only the three failures reachable from ordinary use are downgraded to
    // state (DS32 wants the refusal inline, next to the category the user
    // was looking at). Anything else — a locked DB, a driver error — rethrows
    // to `error.tsx`, which is the actual backstop this comment promises.
    if (
      err instanceof CategoryKindChangeRefusedError ||
      err instanceof CategoryNotFoundError ||
      err instanceof ProtectedCategoryKindError
    ) {
      return { status: "error", message: err.message };
    }
    throw err;
  }

  // setCategoryKind's own docstring says the blast radius includes the
  // trend chart, goal inclusion, and categorize eligibility — revalidating
  // only /budget left "/", "/goals", and "/categorize" free to keep serving
  // a stale RSC payload with the category's old kind until an unrelated
  // mutation or a hard refresh (caught by Codex adversarial review via /ship).
  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
  revalidatePath("/");
  revalidatePath("/goals");
  revalidatePath("/categorize");
  return { status: "ok", categoryId: parsed.data.categoryId };
}

export type CommitAllocationResult =
  | { status: "ok"; allocation: EffectiveAllocation }
  | { status: "error"; message: string };

/**
 * T18/P2 — `<MonthEditor>`'s inline commit path. A plain callable Server
 * Action (called directly from a client `onCommit`, not a `<form action>`),
 * same shape as `copyPreviousMonthAction`: no `redirect`, no
 * `revalidatePath` — P2 keeps this off the hot path (40 commits/session)
 * and moves cache invalidation to `revalidateBudgetSurfacesAction`, fired
 * once when the editor loses focus or unmounts.
 *
 * Takes already-parsed cents rather than a dollar string: `CurrencyInput`
 * owns `parseAmountToCents` client-side for instant inline validation
 * (C3's bound especially — a pasted account number must never round-trip to
 * the server before the user sees an error). `validateAllocateInput` still
 * re-checks everything here regardless, since a Server Action is a network
 * endpoint a client bug (or a request that didn't come from this UI at all)
 * can call directly with anything.
 */
export async function commitAllocationAction(
  categoryId: number,
  year: number,
  month: number,
  allocatedCents: number,
): Promise<CommitAllocationResult> {
  const parsed = validateAllocateInput({ categoryId, year, month, allocatedCents });
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => i.message).join("; ");
    return { status: "error", message };
  }

  try {
    const allocation = upsertAllocation(db, parsed.data);
    return { status: "ok", allocation };
  } catch (err) {
    if (
      err instanceof ParentAllocationError ||
      err instanceof CategoryNotFoundError ||
      err instanceof CategoryArchivedError
    ) {
      return { status: "error", message: err.message };
    }
    throw err;
  }
}

/**
 * T18/P2 — the other half of "revalidate once on exit": `<MonthEditor>`
 * calls this when focus leaves the whole island (or on unmount, covering
 * client-side navigation to another month) rather than after every commit.
 * Keeps `/budget`'s dashboard tile and this route's own SummaryStrip/
 * FirstRunCard correct on the NEXT visit without racing 40 in-flight
 * `revalidatePath` calls against the client's own optimistic state during
 * the session (the out-of-order-arrival problem P2 documents in the plan).
 */
export async function revalidateBudgetSurfacesAction(year: number, month: number): Promise<void> {
  revalidatePath("/budget");
  revalidatePath(`/budget/${year}/${month}`);
}

const copyPreviousMonthInputSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * T16c/DS7 — called directly from a client transition (not a `<form
 * action>`), same pattern as `bulkCategorizeMerchantAction` on
 * `/categorize`: the caller wants the real `{copied, skipped,
 * skippedArchived}` counts to build its own Sonner toast message, not a
 * generic ok/error union.
 */
export async function copyPreviousMonthAction(year: number, month: number): Promise<CopyPreviousMonthResult> {
  const parsed = copyPreviousMonthInputSchema.safeParse({ year, month });
  if (!parsed.success) {
    throw new Error(`Invalid copy-month request — ${formatZodIssues(parsed.error)}`);
  }
  const result = copyPreviousMonth(db, parsed.data.year, parsed.data.month);
  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
  return result;
}

/* ── PR2b — category CRUD and archive (T25/T27/T29) ──────────────────────
 * All plain callable Server Actions (no `<form action>`/`useActionState`
 * boilerplate) returning `{status:"ok",...}|{status:"error",message}`, the
 * same shape `commitAllocationAction`/T18 established — DS20's inline row
 * and `⋯` menu call these directly from a client `startTransition`, the
 * same way `<MonthEditor>` calls `commitAllocationAction`.
 *
 * Every action here revalidates `/transactions` and `/categorize` in
 * addition to `/budget` — unlike `upsertBudgetAllocationAction` or
 * `setCategoryKindAction`, these change what category EXISTS or what its
 * NAME/archived state is, which both pages' pickers and label lookups read
 * (`listLeafCategories`). Allocating or reclassifying an existing category
 * doesn't need that — the category set itself didn't change. */
function revalidateCategorySurfaces(): void {
  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
  revalidatePath("/budget/categories");
  revalidatePath("/transactions");
  revalidatePath("/categorize");
}

const categoryNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(80, "Name must be 80 characters or fewer");

export type CreateCategoryActionResult =
  | { status: "ok"; category: CreatedCategory }
  | { status: "error"; message: string };

export async function createCategoryGroupAction(name: string): Promise<CreateCategoryActionResult> {
  const parsed = categoryNameSchema.safeParse(name);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid name" };
  }
  try {
    const category = createCategoryGroup(db, parsed.data);
    revalidateCategorySurfaces();
    return { status: "ok", category };
  } catch (err) {
    if (err instanceof CategoryNameTakenError) return { status: "error", message: err.message };
    throw err;
  }
}

const createCategoryInputSchema = z.object({
  name: categoryNameSchema,
  kind: z.enum(["income", "expense", "fund"]),
  parentId: z.number().int().positive().nullable(),
  carryoverPolicy: z.enum(["none", "rollover", "reset"]).default("none"),
});

export async function createCategoryAction(params: {
  name: string;
  kind: "income" | "expense" | "fund";
  parentId: number | null;
  carryoverPolicy?: "none" | "rollover" | "reset";
}): Promise<CreateCategoryActionResult> {
  const parsed = createCategoryInputSchema.safeParse(params);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid category" };
  }
  try {
    const category = createCategory(db, parsed.data);
    revalidateCategorySurfaces();
    return { status: "ok", category };
  } catch (err) {
    if (err instanceof CategoryNameTakenError || err instanceof CategoryNotFoundError) {
      return { status: "error", message: err.message };
    }
    throw err;
  }
}

export type RenameCategoryActionResult =
  | { status: "ok"; categoryId: number; name: string }
  | { status: "error"; message: string };

export async function renameCategoryAction(categoryId: number, name: string): Promise<RenameCategoryActionResult> {
  const parsedName = categoryNameSchema.safeParse(name);
  if (!parsedName.success) {
    return { status: "error", message: parsedName.error.issues[0]?.message ?? "Invalid name" };
  }
  try {
    const renamed = renameCategory(db, categoryId, parsedName.data);
    revalidateCategorySurfaces();
    return { status: "ok", categoryId: renamed.id, name: renamed.name };
  } catch (err) {
    if (err instanceof CategoryNameTakenError || err instanceof CategoryNotFoundError) {
      return { status: "error", message: err.message };
    }
    throw err;
  }
}

export type SetCarryoverPolicyActionResult =
  | { status: "ok"; categoryId: number; carryoverPolicy: "none" | "rollover" | "reset" }
  | { status: "error"; message: string };

const setCarryoverPolicyInputSchema = z.object({
  categoryId: z.number().int().positive(),
  carryoverPolicy: z.enum(["none", "rollover", "reset"]),
});

export async function setCarryoverPolicyAction(
  categoryId: number,
  carryoverPolicy: "none" | "rollover" | "reset",
): Promise<SetCarryoverPolicyActionResult> {
  // Unlike `createCategoryAction`/`renameCategoryAction`/`setCategoryKindAction`
  // above, this took its enum param on trust — a plain callable Server
  // Action is a network-reachable endpoint regardless of what the
  // TypeScript signature says, so an out-of-band request with a string
  // outside the enum would have reached `setCarryoverPolicy`'s DB write
  // unvalidated (Drizzle's `text(..., {enum:[...]})` is TypeScript-only,
  // no SQL CHECK constraint).
  const parsed = setCarryoverPolicyInputSchema.safeParse({ categoryId, carryoverPolicy });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid carryover policy" };
  }
  try {
    const result = setCarryoverPolicy(db, parsed.data.categoryId, parsed.data.carryoverPolicy);
    // `revalidateCategorySurfaces` (not a hand-rolled 2-of-5 subset, which
    // this used to be): `/budget/categories` renders `carryoverPolicy`
    // directly and was left stale by the previous, narrower revalidate.
    revalidateCategorySurfaces();
    return { status: "ok", ...result };
  } catch (err) {
    if (err instanceof CategoryNotFoundError) return { status: "error", message: err.message };
    throw err;
  }
}

export type ArchiveCategoryActionResult =
  | { status: "ok"; categoryId: number; categoryName: string }
  | { status: "error"; message: string };

export async function archiveCategoryAction(categoryId: number): Promise<ArchiveCategoryActionResult> {
  try {
    const result = archiveCategory(db, categoryId);
    revalidateCategorySurfaces();
    return { status: "ok", categoryId: result.categoryId, categoryName: result.categoryName };
  } catch (err) {
    if (
      err instanceof CategoryNotFoundError ||
      err instanceof UncategorizedArchiveError ||
      err instanceof CategoryHasChildrenError ||
      err instanceof CategoryArchiveRefusedError
    ) {
      return { status: "error", message: err.message };
    }
    throw err;
  }
}

export async function unarchiveCategoryAction(categoryId: number): Promise<ArchiveCategoryActionResult> {
  try {
    const result = unarchiveCategory(db, categoryId);
    revalidateCategorySurfaces();
    return { status: "ok", categoryId: result.categoryId, categoryName: result.categoryName };
  } catch (err) {
    if (err instanceof CategoryNotFoundError) return { status: "error", message: err.message };
    throw err;
  }
}

export type MoveCategoryActionResult =
  | { status: "ok"; result: MoveCategoryResult }
  | { status: "error"; message: string };

const moveCategoryInputSchema = z.object({
  categoryId: z.number().int().positive(),
  direction: z.enum(["up", "down"]),
});

/**
 * T29: one parameterized action rather than the plan's literal
 * `moveCategoryUpAction`/`moveCategoryDownAction` pair — same behavior,
 * one Zod schema and one error-mapping block instead of two copies of both.
 */
export async function moveCategoryAction(categoryId: number, direction: MoveDirection): Promise<MoveCategoryActionResult> {
  const parsed = moveCategoryInputSchema.safeParse({ categoryId, direction });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid move request" };
  }
  try {
    const result = moveCategory(db, parsed.data.categoryId, parsed.data.direction);
    revalidatePath("/budget");
    revalidatePath("/budget/[year]/[month]", "page");
    revalidatePath("/budget/categories");
    return { status: "ok", result };
  } catch (err) {
    if (err instanceof CategoryNotFoundError) return { status: "error", message: err.message };
    throw err;
  }
}
