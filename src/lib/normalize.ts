export function normalizeMerchant(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");

  s = s.replace(/\s*Card #:\d+\s*$/i, "");

  s = s.replace(/^POS\s+\d{4}\s+\d{4}\s+\d+\s+/i, "");
  s = s.replace(/^ATM\s+\d{4}\s+\d{4}\s+\d+\s+/i, "");
  s = s.replace(/^SBI\s+\d{4}\s+\d{4}\s+\d+\s+/i, "");

  s = s.replace(/\s+Ref#\s*\S+\s*$/i, "");

  s = s.replace(/\s+\d{3}[-.]?\d{3}[-.]?\d{4}\s+[A-Z]{2}\s*$/i, "");

  s = s.replace(/\s+\d{6}\s*$/, "");

  s = s.replace(/\s+#\d+\b/g, "");

  s = s.replace(/^(.{3,}?)\s+[A-Z]{2}\s*$/i, "$1");

  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

export function extractCardLastFour(raw: string): string | null {
  const match = raw.match(/Card #:(\d+)/i);
  if (!match) return null;
  return match[1].slice(-4);
}
