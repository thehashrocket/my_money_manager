/**
 * Memo whitespace differs by source and must not decide a dedup question.
 * Star One's CSV pads pending-row memos with leading spaces and `parseCsv`
 * preserves them verbatim on purpose (`import_row_hash` is derived from the
 * exact bytes, so trimming there would break hash stability). The feed's memo
 * arrives trimmed. Normalising both sides here — rather than changing either
 * source — keeps that hash contract intact while letting the two representations
 * of one transaction compare equal.
 */
function normalizeMemoForSignature(memo: string): string {
  return memo.trim().replace(/\s+/g, " ");
}

/**
 * Content signature for source-independent dedup: the identity of a
 * transaction as the *bank* sees it, with nothing in it that belongs to how the
 * row happened to arrive.
 *
 * Both write paths need it, for the same underlying reason — neither of their
 * primary dedup keys is stable across two views of the same transaction:
 *
 * - **Sync** (`simplefin/sync.ts`): the 90 days SimpleFIN returns overlap
 *   history already imported from CSV, and those rows have no `external_id` to
 *   match on. Without the whitespace normalisation this misses exactly the rows
 *   it exists for: a row imported from CSV while pending (padded memo) that
 *   later posts and comes back on the feed (trimmed memo).
 * - **CSV import** (`importBatch.ts`): `import_row_hash` mixes in the row's
 *   index within its source file (CLAUDE.md rule 3, so two identical same-day
 *   coffees both survive). Star One exports an arbitrary date range, so a wider
 *   re-export puts already-imported rows at new offsets and every hash changes.
 *
 * Deliberately NOT keyed on `raw_description`: it is `WITHDRAWAL`/`DEPOSIT` on
 * the CSV side and derived from the sign of `amount_cents` on the feed side, so
 * it carries no information `amountCents` does not already carry.
 *
 * Signatures repeat legitimately — two identical same-day coffees produce one
 * signature twice — so callers must count them as a multiset (a budget map),
 * never collapse them into a `Set`.
 */
export function contentSignature(r: {
  date: string;
  amountCents: number;
  rawMemo: string;
}): string {
  return `${r.date}|${r.amountCents}|${normalizeMemoForSignature(r.rawMemo)}`;
}
