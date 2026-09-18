import { contentSignature } from "./contentSignature";

export type ContentCandidate = {
  id: number;
  isPending: boolean;
};

/**
 * Groups existing rows into per-signature candidate lists, for claiming
 * during content dedup. Shared by CSV import (`importBatch.ts`) and sync
 * (`simplefin/sync.ts`) — both need to tell a PENDING existing row apart from
 * a posted one at the same signature, not just count how many exist.
 *
 * Row order within one signature's list is whatever the caller's query
 * returned — UNSPECIFIED, not "oldest" or "newest". Neither caller may rely
 * on which one comes back when several rows share a signature; a repeated
 * signature is a real repeat (two identical same-day coffees), not a case
 * where "which one" matters.
 */
export function buildContentCandidates<
  T extends { date: string; amountCents: number; rawMemo: string; id: number; isPending: boolean },
>(existingRows: T[]): Map<string, ContentCandidate[]> {
  const candidates = new Map<string, ContentCandidate[]>();
  for (const r of existingRows) {
    const sig = contentSignature(r);
    const list = candidates.get(sig) ?? [];
    list.push({ id: r.id, isPending: r.isPending });
    candidates.set(sig, list);
  }
  return candidates;
}

/**
 * Claims and removes ONE pending candidate for `sig`, or returns `undefined`
 * if none is pending — this function never claims a posted candidate. That
 * asymmetry is deliberate: a pending existing row matching a posted incoming
 * row is that row's real-world counterpart finally arriving (a promotion
 * target), which is a different fact from "this is a plain repeat" and needs
 * different handling by the caller (an in-place UPDATE, not a duplicate
 * drop). A caller that also wants "claim anything, pending preferred" (CSV's
 * own dedup, which treats a posted match as an ordinary duplicate too) calls
 * this first and falls back to popping the list itself.
 */
export function claimPendingCandidate(
  candidates: Map<string, ContentCandidate[]>,
  sig: string,
): ContentCandidate | undefined {
  const list = candidates.get(sig);
  if (!list || list.length === 0) return undefined;
  const pendingIndex = list.findIndex((c) => c.isPending);
  if (pendingIndex === -1) return undefined;
  return list.splice(pendingIndex, 1)[0];
}
