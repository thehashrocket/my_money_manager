import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { listAccounts, listCardAccounts } from "./listAccounts";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount(name: string, type: "checking" | "savings" | "credit" | "loan" = "checking") {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name,
      type,
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
    .returning()
    .all();
  return row;
}

describe("listAccounts", () => {
  it("returns an empty list when there are no accounts", () => {
    expect(listAccounts(handle.db)).toEqual([]);
  });

  it("returns all accounts as {id, name}, sorted by name", () => {
    seedAccount("Savings");
    seedAccount("Checking");

    const result = listAccounts(handle.db);
    expect(result.map((a) => a.name)).toEqual(["Checking", "Savings"]);
    expect(Object.keys(result[0]).sort()).toEqual(["id", "name"]);
  });

  it("includes a credit card — good, and unplanned (E15)", () => {
    seedAccount("Checking");
    seedAccount("Visa", "credit");

    // A card carries manually-entered charges, so filtering /transactions by
    // one is genuinely useful. This fell out of migration 0018's enum
    // widening rather than being designed, which is exactly why E15 went
    // looking for every unfiltered `select().from(accounts)`.
    expect(listAccounts(handle.db).map((a) => a.name)).toEqual(["Checking", "Visa"]);
  });

  it("excludes a mortgage — a permanently empty filter option (E15)", () => {
    seedAccount("Checking");
    seedAccount("Mortgage", "loan");

    // D3=A: a loan never gets a transaction row, and that is now enforced on
    // all three write paths (E1 sync, E6 CSV, E17 manual). Offering it here
    // can only ever produce "no transactions found", which teaches the user
    // the filter is broken rather than that the account is empty.
    expect(listAccounts(handle.db).map((a) => a.name)).toEqual(["Checking"]);
  });

  it("returns an empty list when the only account is a mortgage", () => {
    seedAccount("Mortgage", "loan");
    expect(listAccounts(handle.db)).toEqual([]);
  });
});

describe("listCardAccounts", () => {
  it("returns credit cards only, sorted by name", () => {
    seedAccount("Checking");
    seedAccount("Visa", "credit");
    seedAccount("Amex", "credit");
    seedAccount("Mortgage", "loan");
    seedAccount("Savings", "savings");

    expect(listCardAccounts(handle.db).map((a) => a.name)).toEqual(["Amex", "Visa"]);
  });

  it("excludes a loan — not accountClass, deliberately", () => {
    // A mortgage is a valid liability and an invalid payment target.
    // manualTransaction rejects it at the shared entry regardless (E17); this
    // is the half that never offers it, so the refusal stays a guard rather
    // than something users trip over.
    seedAccount("Mortgage", "loan");
    expect(listCardAccounts(handle.db)).toEqual([]);
  });

  it("returns an empty list when no cards exist, so the menu can say so", () => {
    seedAccount("Checking");
    expect(listCardAccounts(handle.db)).toEqual([]);
  });
});
