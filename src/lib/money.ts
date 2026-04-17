/**
 * Format a signed integer cent amount as a USD string.
 *
 * Negatives render in accounting parens — `($42.00)` — per the Weekend 2 design
 * decision. Zero is rendered as `$0.00` without parens.
 */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const body = `$${(abs / 100).toFixed(2)}`;
  return cents < 0 ? `(${body})` : body;
}
