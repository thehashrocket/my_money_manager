import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { listAccounts } from "./listAccounts";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount(name: string) {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name,
      type: "checking",
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
});
