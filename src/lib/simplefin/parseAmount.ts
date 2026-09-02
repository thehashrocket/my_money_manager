/**
 * SimpleFIN sends amounts as decimal strings ("-178.97"). Parsing them with
 * `parseFloat(x) * 100` reintroduces binary-float error into the one thing this
 * app refuses to get wrong (CLAUDE.md rule 1), so this does string math only.
 *
 * The sign is passed through untouched — SimpleFIN's signs are already correct
 * for the same reason the CSV's are (rule 2): nobody transformed the data.
 */
export class SimpleFinAmountError extends Error {
  constructor(raw: unknown) {
    super(`Unparseable SimpleFIN amount: ${JSON.stringify(raw)}`);
    this.name = "SimpleFinAmountError";
  }
}

const AMOUNT_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

export function parseAmountToCents(raw: string): number {
  if (typeof raw !== "string") throw new SimpleFinAmountError(raw);
  const match = AMOUNT_RE.exec(raw.trim());
  if (!match) throw new SimpleFinAmountError(raw);

  const [, sign, whole, frac = ""] = match;
  const wholeCents = Number(whole) * 100;
  if (!Number.isSafeInteger(wholeCents)) throw new SimpleFinAmountError(raw);

  let cents = wholeCents + Number((frac + "00").slice(0, 2));
  // Round half away from zero on the third decimal. Star One always sends
  // exactly 2dp, but the spec permits more and silent truncation would leak
  // money over time.
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;

  return sign === "-" ? -cents : cents;
}
