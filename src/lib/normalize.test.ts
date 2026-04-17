import { describe, it, expect } from "vitest";
import { normalizeMerchant, extractCardLastFour } from "./normalize";

describe("normalizeMerchant", () => {
  it("strips Card #:XXXX and trailing state code", () => {
    expect(normalizeMerchant("TST*THE BRASS TAP - Modesto CA Card #:8568")).toBe(
      "TST*THE BRASS TAP - MODESTO",
    );
  });

  it("strips trailing 6-digit YYMMDD ACH code", () => {
    expect(normalizeMerchant("Execupay  01QSXBDIR DEP   260410")).toBe(
      "EXECUPAY 01QSXBDIR DEP",
    );
    expect(normalizeMerchant("VERIZON WIRELESSPAYMENTS  260325")).toBe(
      "VERIZON WIRELESSPAYMENTS",
    );
    expect(normalizeMerchant("AMEX EPAYMENT   ACH PMT   260413")).toBe(
      "AMEX EPAYMENT ACH PMT",
    );
  });

  it("strips POS leading prefix on refunds", () => {
    expect(
      normalizeMerchant("POS 0325 1536 082706 CHEAPER CIGARETTES MANTECA CA"),
    ).toBe("CHEAPER CIGARETTES MANTECA");
  });

  it("strips ATM leading prefix with space-padded address", () => {
    const raw =
      "ATM 0416 1709 681145 206 E YOSEMITE AVE      MANTECA      CA Card #:7190";
    expect(normalizeMerchant(raw)).toBe("206 E YOSEMITE AVE MANTECA");
  });

  it("strips SBI mobile deposit prefix", () => {
    expect(
      normalizeMerchant(
        "SBI 0413 0644 423142 Mobile Deposit          Star One CU  CA",
      ),
    ).toBe("MOBILE DEPOSIT STAR ONE CU");
  });

  it("strips trailing Ref# token", () => {
    expect(normalizeMerchant("Online 04/15/2026 07:23:00 Ref# 436EF")).toBe(
      "ONLINE 04/15/2026 07:23:00",
    );
  });

  it("strips mid-string #digits store number and trailing state", () => {
    expect(normalizeMerchant("  COSTCO WHSE #1031  MANTECA  CA")).toBe(
      "COSTCO WHSE MANTECA",
    );
  });

  it("strips trailing phone + state", () => {
    expect(
      normalizeMerchant("STARBUCKS 800782728 800-782-7282 WA Card #:7190"),
    ).toBe("STARBUCKS 800782728");
    expect(
      normalizeMerchant("GOOGLE *Google One 855-836-3987 CA Card #:8568"),
    ).toBe("GOOGLE *GOOGLE ONE");
  });

  it("preserves DEPOSIT-OVERDRAFT and WITHDRAWAL-OVERDRAFT so transfer matcher can confirm", () => {
    expect(normalizeMerchant("DEPOSIT-OVERDRAFT")).toBe("DEPOSIT-OVERDRAFT");
    expect(normalizeMerchant("WITHDRAWAL-OVERDRAFT")).toBe("WITHDRAWAL-OVERDRAFT");
  });

  it("collapses multiple internal spaces and uppercases", () => {
    expect(normalizeMerchant("  hello   world  ")).toBe("HELLO WORLD");
  });

  it("does not strip trailing 2-letter token when it's the whole string", () => {
    expect(normalizeMerchant("CA")).toBe("CA");
  });
});

describe("extractCardLastFour", () => {
  it("extracts last four from Card #:XXXX", () => {
    expect(
      extractCardLastFour("TST*THE BRASS TAP - Modesto CA Card #:8568"),
    ).toBe("8568");
    expect(
      extractCardLastFour("AMAZON MKTPL*BY3IK6 WA Card #:7190"),
    ).toBe("7190");
  });

  it("returns null when no card number is present", () => {
    expect(extractCardLastFour("DEPOSIT-OVERDRAFT")).toBeNull();
    expect(extractCardLastFour("Execupay  01QSXBDIR DEP   260410")).toBeNull();
  });
});
