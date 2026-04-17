export type RawDescription = "WITHDRAWAL" | "DEPOSIT";

export type ParsedRow = {
  rowIndex: number;
  bankTransactionNumber: string;
  date: string;
  rawDescription: RawDescription;
  rawMemo: string;
  amountCents: number;
  balanceCents: number | null;
  checkNumber: string | null;
  fees: string | null;
  isPending: boolean;
};

export type ParseError = {
  rowIndex: number;
  raw: string;
  reason: string;
};

export type ParseResult = {
  rows: ParsedRow[];
  errors: ParseError[];
};

function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  const n = text.length;

  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(cur);
      cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    if (c === '"' && cur.length === 0) {
      inQuotes = true;
      continue;
    }
    cur += c;
  }

  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  return rows;
}

function mmddyyyyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yyyy = Number(m[3]);
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;
  if (yyyy < 1900 || yyyy > 2999) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

function parseDecimalToCents(s: string | undefined): number | null {
  if (!s || s.trim() === "") return null;
  const n = Number(s.trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function isStarOneHeader(cells: string[]): boolean {
  return (
    cells.length >= 4 &&
    cells[0].trim().toLowerCase() === "transaction number" &&
    cells[1].trim().toLowerCase() === "date"
  );
}

export function parseStarOneCsv(text: string): ParseResult {
  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];
  const tokens = tokenizeCsv(text);
  if (tokens.length === 0) return { rows, errors };

  const startIdx = isStarOneHeader(tokens[0]) ? 1 : 0;

  for (let i = startIdx; i < tokens.length; i++) {
    const dataIdx = i - startIdx;
    const cells = tokens[i];
    const raw = cells.join(",");

    if (cells.length < 7) {
      errors.push({
        rowIndex: dataIdx,
        raw,
        reason: `expected at least 7 columns, got ${cells.length}`,
      });
      continue;
    }

    const [txn, date, desc, memo, debit, credit, bal, check, fees] = cells;

    const iso = mmddyyyyToIso(date);
    if (!iso) {
      errors.push({ rowIndex: dataIdx, raw, reason: `invalid date: "${date}"` });
      continue;
    }

    if (desc !== "WITHDRAWAL" && desc !== "DEPOSIT") {
      errors.push({ rowIndex: dataIdx, raw, reason: `unknown Description: "${desc}"` });
      continue;
    }

    const debitCents = parseDecimalToCents(debit);
    const creditCents = parseDecimalToCents(credit);
    if (debitCents !== null && creditCents !== null) {
      errors.push({ rowIndex: dataIdx, raw, reason: "both Debit and Credit populated" });
      continue;
    }
    const amountCents = debitCents ?? creditCents;
    if (amountCents === null) {
      errors.push({ rowIndex: dataIdx, raw, reason: "neither Debit nor Credit populated" });
      continue;
    }

    const balanceCents = parseDecimalToCents(bal);
    const txnNum = txn.trim();
    const isPending =
      txnNum === "6098" && (balanceCents === null || balanceCents === 0);

    rows.push({
      rowIndex: dataIdx,
      bankTransactionNumber: txnNum,
      date: iso,
      rawDescription: desc as RawDescription,
      rawMemo: memo,
      amountCents,
      balanceCents,
      checkNumber: check && check.trim() !== "" ? check.trim() : null,
      fees: fees && fees.trim() !== "" ? fees.trim() : null,
      isPending,
    });
  }

  return { rows, errors };
}
