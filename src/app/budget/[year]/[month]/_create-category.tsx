"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TableCell, TableRow } from "@/components/ui/table";
import { createCategoryAction, createCategoryGroupAction } from "../../actions";

/**
 * DS20 — "a persistent last row per group ('+ Add a line to Housing' — a
 * text input that creates on Enter and immediately focuses the new row's
 * amount cell)." Creating a category server-side (via `revalidatePath`)
 * then makes the new row appear through the ordinary props flow — no
 * client-side optimistic row injection needed, `<ExpenseTable>`'s
 * `sections.map(...)` just renders whatever the refreshed server props say.
 * What DOES need help: focusing that new row's `<CurrencyInput>` once it
 * exists, since it isn't in the DOM at the moment this component fires the
 * create — `waitForCategoryInput` polls briefly for the element the
 * refreshed render will produce.
 */
function waitForCategoryInput(categoryId: number, onFound: () => void): () => void {
  let attempts = 0;
  const maxAttempts = 60; // ~1s at one rAF tick apiece
  let frame: number;
  const tick = () => {
    const el = document.querySelector<HTMLElement>(`[data-category-id="${categoryId}"]`);
    if (el) {
      el.focus();
      onFound();
      return;
    }
    attempts += 1;
    if (attempts < maxAttempts) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

export function NewCategoryRow({
  parentId,
  parentName,
  kind = "expense",
  colSpan,
  mobile,
}: {
  parentId: number | null;
  parentName: string | null;
  /** Income has no group concept in the current taxonomy (every income leaf
   * is unparented), so callers on that band always pass `parentId: null`
   * alongside this — the row still works the same way, just always in the
   * band's one flat bucket. */
  kind?: "income" | "expense" | "fund";
  colSpan?: number;
  mobile?: boolean;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelWaitRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelWaitRef.current?.(), []);

  const placeholder = parentName ? `+ Add a line to ${parentName}` : "+ Add a line";

  async function submit() {
    const trimmed = name.trim();
    if (trimmed === "" || pending) return;
    setPending(true);
    setError(null);
    const result = await createCategoryAction({ name: trimmed, kind, parentId });
    setPending(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    setName("");
    cancelWaitRef.current?.();
    cancelWaitRef.current = waitForCategoryInput(result.category.id, () => {
      cancelWaitRef.current = null;
    });
  }

  const input = (
    <div className="flex flex-col gap-0.5">
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          // Enter only — not blur. A successful create refocuses the new
          // row's amount input (below), which would steal focus from
          // wherever the user just clicked if blur could trigger it too.
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={pending}
        className="h-8 w-full min-w-0 rounded-sm border border-transparent bg-transparent px-2 text-sm text-ink-2 outline-none placeholder:text-ink-3 hover:border-[var(--rule-faint)] focus-visible:border-[var(--rule-regular)] focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      {error ? <span className="px-2 text-[10px] text-money-neg">{error}</span> : null}
    </div>
  );

  if (mobile) {
    return <li className="px-3 py-1.5">{input}</li>;
  }

  // No wrapping `<TableBody>` — the caller already renders this inside the
  // group's own `<TableBody>` (one `<tbody>` per group, DS44/T12), so a
  // second one here would nest `<tbody>` inside `<tbody>`, which is invalid
  // HTML and trips a hydration mismatch.
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan ?? 1} className="p-0">
        {input}
      </TableCell>
    </TableRow>
  );
}

/**
 * DS20 — the Expenses band footer's "+ Add a group." Plain text input +
 * button rather than the row's inline-on-Enter pattern: a group is created
 * far less often than a leaf, so a small deliberate confirm step (the
 * button) is the right amount of friction, not a footgun to avoid.
 *
 * A group with zero children is invisible as a group: `loadMonthView.ts`'s
 * `groupIntoSections` only emits a section for a `parent_id` that some
 * EXISTING leaf already references, so a just-created empty group renders
 * (indistinguishably from a real category) as an ordinary top-level expense
 * leaf, complete with its own `CurrencyInput` — there is no schema column
 * marking "this row is a group," only "something points at it as a parent."
 * Rather than add one, this flow never lets that state persist unattended:
 * a successful group creation immediately becomes a "+ Add a line to
 * {group}" step for the SAME parent id, so the group has ≥1 real child by
 * the time the user is done here. Abandoning that second step (navigating
 * away) still leaves an empty, leaf-shaped group behind — recoverable via
 * archive (F4 allows archiving a childless, zero-allocation category) — but
 * completing the flow as designed never produces one.
 */
export function NewGroupRow() {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingGroup, setPendingGroup] = useState<{ id: number; name: string } | null>(null);

  async function submitGroup() {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setPending(true);
    setError(null);
    const result = await createCategoryGroupAction(trimmed);
    setPending(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    setName("");
    setPendingGroup({ id: result.category.id, name: result.category.name });
  }

  if (pendingGroup) {
    return (
      <FirstLeafForm
        parentId={pendingGroup.id}
        parentName={pendingGroup.name}
        onDone={() => {
          setPendingGroup(null);
          toast.success(`Added "${pendingGroup.name}".`);
        }}
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submitGroup();
      }}
      className="flex items-center gap-2 pt-1"
    >
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder="+ Add a group"
        disabled={pending}
        className="h-8 w-48 rounded-sm border border-[var(--rule-faint)] bg-transparent px-2 text-sm text-ink-2 outline-none placeholder:text-ink-3 focus-visible:border-[var(--rule-regular)] focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <button
        type="submit"
        disabled={pending || name.trim() === ""}
        className="text-sm text-terracotta underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-50"
      >
        Add
      </button>
      {error ? <span className="text-[10px] text-money-neg">{error}</span> : null}
    </form>
  );
}

/** The forced second step of `NewGroupRow` — same create-a-leaf mechanics as
 * `NewCategoryRow`, but not that component itself: `NewCategoryRow` only
 * ever mounts for a parent `groupIntoSections` already recognizes (one that
 * already has a child), which a just-created group by definition doesn't
 * yet, and it has no "I'm done" callback to return to `NewGroupRow`'s idle
 * state. */
function FirstLeafForm({ parentId, parentName, onDone }: { parentId: number; parentName: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelWaitRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelWaitRef.current?.(), []);

  async function submit() {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setPending(true);
    setError(null);
    const result = await createCategoryAction({ name: trimmed, kind: "expense", parentId });
    setPending(false);
    if (result.status === "error") {
      setError(result.message);
      return;
    }
    cancelWaitRef.current?.();
    cancelWaitRef.current = waitForCategoryInput(result.category.id, () => {
      cancelWaitRef.current = null;
    });
    onDone();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex items-center gap-2 pt-1"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder={`+ Add a line to ${parentName}`}
        disabled={pending}
        className="h-8 w-48 rounded-sm border border-[var(--rule-faint)] bg-transparent px-2 text-sm text-ink-2 outline-none placeholder:text-ink-3 focus-visible:border-[var(--rule-regular)] focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      <button
        type="submit"
        disabled={pending || name.trim() === ""}
        className="text-sm text-terracotta underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-50"
      >
        Add
      </button>
      {error ? <span className="text-[10px] text-money-neg">{error}</span> : null}
    </form>
  );
}
