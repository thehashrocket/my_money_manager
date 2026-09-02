import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { setAccountLink } from "./link";

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

function read(id: number) {
  return handle.db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id))
    .get();
}

describe("setAccountLink", () => {
  it("links a local account to a SimpleFIN account id", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    expect(read(acct.id)?.simplefinAccountId).toBe("ACT-abc123");
  });

  it("unlinks when passed null, leaving the account CSV-only", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    setAccountLink(acct.id, null, handle.db);
    expect(read(acct.id)?.simplefinAccountId).toBeNull();
  });

  it("refuses to link a SimpleFIN account already claimed by another account", () => {
    // Guards the partial unique index — two local accounts pointing at one
    // feed account would double-import every row.
    const a = seedAccount("Checking");
    const b = seedAccount("Savings");
    setAccountLink(a.id, "ACT-abc123", handle.db);

    expect(() => setAccountLink(b.id, "ACT-abc123", handle.db)).toThrow(
      /already linked/i,
    );
    expect(read(b.id)?.simplefinAccountId).toBeNull();
  });

  it("allows re-saving the same link to the same account (idempotent)", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    expect(() => setAccountLink(acct.id, "ACT-abc123", handle.db)).not.toThrow();
    expect(read(acct.id)?.simplefinAccountId).toBe("ACT-abc123");
  });

  it("throws on an unknown local account rather than silently no-oping", () => {
    expect(() => setAccountLink(9999, "ACT-abc123", handle.db)).toThrow(
      /No such account/i,
    );
  });
});
