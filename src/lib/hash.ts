import { createHash } from "node:crypto";

export type ImportRowHashInput = {
  date: string;
  amountCents: number;
  rawDescription: string;
  rawMemo: string;
  rowIndex: number;
};

export function computeImportRowHash(input: ImportRowHashInput): string {
  const { date, amountCents, rawDescription, rawMemo, rowIndex } = input;
  return createHash("sha1")
    .update(`${date}|${amountCents}|${rawDescription}|${rawMemo}|${rowIndex}`)
    .digest("hex");
}
