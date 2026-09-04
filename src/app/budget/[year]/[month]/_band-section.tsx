/**
 * Shared by `page.tsx` (the read-only FUNDS band, still server-rendered)
 * and `_month-editor.tsx` (the INCOME/EXPENSES bands, client-owned per
 * T18) — no `"use client"` directive of its own, so it compiles into
 * whichever boundary imports it (review decision D6A precedent: shared,
 * not duplicated, once a helper has two real callers).
 */
export function BandSection({
  heading,
  id,
  children,
}: {
  heading: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-2">
      <h2 className="font-mono text-xs uppercase tracking-[0.14em] text-ink-2">{heading}</h2>
      {children}
    </section>
  );
}
