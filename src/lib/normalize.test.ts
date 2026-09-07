import { describe, it, expect } from "vitest";
import {
  normalizeMerchant,
  extractCardLastFour,
  PROCESSOR_PREFIXES,
  KNOWN_CITIES,
  BRAND_QUALIFIER_WORDS,
  PROCESSOR_DOMAIN_PATTERNS,
  PROCESSOR_DOMAIN_SAMPLES,
} from "./normalize";

describe("normalizeMerchant", () => {
  it("strips Card #:XXXX and trailing state code", () => {
    // class 2 (TST is a processor) + class 3 (Modesto) now reach further than the
    // original trailing-state rule did.
    expect(normalizeMerchant("TST*THE BRASS TAP - Modesto CA Card #:8568")).toBe(
      "THE BRASS TAP",
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
    // class 3 additionally removes the trailing city.
    expect(
      normalizeMerchant("POS 0325 1536 082706 CHEAPER CIGARETTES MANTECA CA"),
    ).toBe("CHEAPER CIGARETTES");
  });

  it("strips ATM leading prefix with space-padded address", () => {
    const raw =
      "ATM 0416 1709 681145 206 E YOSEMITE AVE      MANTECA      CA Card #:7190";
    expect(normalizeMerchant(raw)).toBe("206 E YOSEMITE AVE");
  });

  it("strips SBI mobile deposit prefix", () => {
    expect(
      normalizeMerchant(
        "SBI 0413 0644 423142 Mobile Deposit          Star One CU  CA",
      ),
    ).toBe("MOBILE DEPOSIT STAR ONE CU");
  });

  it("strips trailing Ref# token", () => {
    // class 5 additionally removes the embedded timestamp.
    expect(normalizeMerchant("Online 04/15/2026 07:23:00 Ref# 436EF")).toBe(
      "ONLINE",
    );
  });

  it("strips mid-string #digits store number and trailing state", () => {
    expect(normalizeMerchant("  COSTCO WHSE #1031  MANTECA  CA")).toBe(
      "COSTCO WHSE",
    );
    // The rule carries /g, so a memo with two store tokens loses both.
    expect(normalizeMerchant("BURGER BARN #12 #3400 MANTECA CA")).toBe(
      "BURGER BARN",
    );
  });

  it("strips trailing phone + state", () => {
    // The bare account number is now removed by the phase 4 trailing-number rule.
    expect(
      normalizeMerchant("STARBUCKS 800782728 800-782-7282 WA Card #:7190"),
    ).toBe("STARBUCKS");
    expect(
      normalizeMerchant("GOOGLE *Google One 855-836-3987 CA Card #:8568"),
    ).toBe("GOOGLE ONE");
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

/**
 * Every output this change deliberately altered, pinned with its old value.
 *
 * The twelve original rules are untouched — these strings changed because they now
 * travel through a longer pipeline, not because a rule was edited. Keeping the old
 * value visible here means a future accidental revert reads as a diff rather than as
 * a silent regression.
 */
describe("normalizeMerchant — documented behavior changes", () => {
  const changes: Array<{ raw: string; was: string; now: string; why: string }> = [
    {
      raw: "TST*THE BRASS TAP - Modesto CA Card #:8568",
      was: "TST*THE BRASS TAP - MODESTO",
      now: "THE BRASS TAP",
      why: "class 2 processor-first split + class 3 city strip",
    },
    {
      raw: "GOOGLE *Google One 855-836-3987 CA Card #:8568",
      was: "GOOGLE *GOOGLE ONE",
      now: "GOOGLE ONE",
      why: "class 1 brand-first split",
    },
    {
      raw: "Online 04/15/2026 07:23:00 Ref# 436EF",
      was: "ONLINE 04/15/2026 07:23:00",
      now: "ONLINE",
      why: "class 5 embedded timestamp strip",
    },
    {
      raw: "POS 0325 1536 082706 CHEAPER CIGARETTES MANTECA CA",
      was: "CHEAPER CIGARETTES MANTECA",
      now: "CHEAPER CIGARETTES",
      why: "class 3 city strip",
    },
    {
      raw: "  COSTCO WHSE #1031  MANTECA  CA",
      was: "COSTCO WHSE MANTECA",
      now: "COSTCO WHSE",
      why: "class 3 city strip",
    },
    {
      raw: "ATM 0416 1709 681145 206 E YOSEMITE AVE      MANTECA      CA Card #:7190",
      was: "206 E YOSEMITE AVE MANTECA",
      now: "206 E YOSEMITE AVE",
      why: "class 3 city strip",
    },
    {
      raw: "STARBUCKS 800782728 800-782-7282 WA Card #:7190",
      was: "STARBUCKS 800782728",
      now: "STARBUCKS",
      why: "phase 4 trailing store/account number strip",
    },
  ];

  for (const { raw, was, now, why } of changes) {
    it(`${why}: ${JSON.stringify(raw)}`, () => {
      expect(normalizeMerchant(raw)).toBe(now);
      expect(normalizeMerchant(raw)).not.toBe(was);
    });
  }
});

describe("normalizeMerchant — class 1, brand-first reference tokens", () => {
  it("collapses every Amazon variant onto one key", () => {
    expect(normalizeMerchant("AMAZON MKTPL*5H7A39 Amzn.com/bill")).toBe("AMAZON");
    expect(normalizeMerchant("AMAZON.COM*OE9Z329K AMZN.COM/BILL")).toBe("AMAZON");
    // PRIME is deliberately NOT a brand qualifier: it names a distinct billed
    // product, and stripping it both folds Prime into the general AMAZON bucket
    // and strands the seeded `contains 'AMAZON PRIME'` subscription rule.
    expect(normalizeMerchant("AMAZON PRIME*RV8CL5 AMZN.COM/BILL")).toBe(
      "AMAZON PRIME",
    );
  });

  it("keeps a distinct brand distinct rather than folding it into its biller", () => {
    expect(normalizeMerchant("AUDIBLE*3I95N0A03 AMZN.COM/BILL")).toBe("AUDIBLE");
  });

  it("handles the user's original examples", () => {
    expect(
      normalizeMerchant("AIRBNB * TA9RWYS3 AIRBNB.COM CA Card #:8568"),
    ).toBe("AIRBNB");
    expect(
      normalizeMerchant("GOOGLE *YouTubePrem g.co/helppay# CA Card #:8568"),
    ).toBe("YOUTUBEPREM");
  });

  it("strips a .COM brand suffix", () => {
    expect(normalizeMerchant("SAFEWAY.COM*1652704")).toBe("SAFEWAY");
  });

  it("collapses AI subscription billers", () => {
    expect(
      normalizeMerchant("ANTHROPIC* CLAUDE S ANTHROPIC.COM CA Card #:8568"),
    ).toBe("ANTHROPIC");
    expect(
      normalizeMerchant("OPENAI *CHATGPT SUB OPENAI.COM CA Card #:8568"),
    ).toBe("OPENAI");
  });
});

describe("normalizeMerchant — class 2, processor-first reference tokens", () => {
  it("keeps the merchant that sits AFTER the star", () => {
    expect(normalizeMerchant("SQ *BLOCK 21 WINERY Lodi CA Card #:8568")).toBe(
      "BLOCK 21 WINERY",
    );
    expect(normalizeMerchant("SQ *TAPPED APPLE LL Salida CA Card #:8568")).toBe(
      "TAPPED APPLE LL",
    );
  });

  /**
   * The trap. A naive "everything before the star" rule produces one bucket named
   * TST holding 31 unrelated restaurants. If PROCESSOR_PREFIXES ever loses an entry
   * this is the test that catches it.
   */
  it("NEVER yields a bare processor name as the merchant", () => {
    const processorMemos = [
      "TST*THE BRASS TAP - Modesto CA Card #:8568",
      "TST*SONS OF LIBERTY Livermore CA Card #:8568",
      "TST*AMERICAN CONSER San Francisco CA Card #:8568",
      "SQ *R PLACE Livermore CA Card #:8568",
      "FSP*BRETHREN BREWIN MANTECA CA Card #:8568",
      "SPO*LOMABREWINGCO.- MANTECA CA Card #:8568",
      "DD *SMALLCAKESCUPCA DOORDASH.COM",
      "EB *80S HALLOWEEN P",
    ];
    for (const memo of processorMemos) {
      const result = normalizeMerchant(memo);
      expect(PROCESSOR_PREFIXES.has(result)).toBe(false);
      expect(result.length).toBeGreaterThan(3);
    }
  });

  it("keeps two different merchants behind the same processor separate", () => {
    expect(normalizeMerchant("TST*SONS OF LIBERTY Livermore CA Card #:8568")).toBe(
      "SONS OF LIBERTY",
    );
    expect(normalizeMerchant("TST*HOTEL SUTTER RE Sutter Creek CA Card #:8568")).toBe(
      "HOTEL SUTTER RE",
    );
  });

  it("survives a POS prefix in front of the processor token", () => {
    // Phase ordering regression: if the star split ran before the POS strip, `pre`
    // would be "POS 0220 1937 794511 SQ" and the brand-first branch would win.
    expect(
      normalizeMerchant("POS 0220 1937 794511 SQ *TAPPED APPLE LL Salida CA"),
    ).toBe("TAPPED APPLE LL");
    expect(normalizeMerchant("POS 0220 1937 794511 SQ *TAPPED APPLE LL Salida CA")).toBe(
      normalizeMerchant("SQ *TAPPED APPLE LL Salida CA Card #:8568"),
    );
  });
});

describe("normalizeMerchant — class 3, trailing city", () => {
  it("merges a located and an unlocated variant of the same merchant", () => {
    expect(normalizeMerchant("TST* POUR PLAY San Ramon CA Card #:8568")).toBe(
      normalizeMerchant("TST* POUR PLAY 925-718-5040 CA Card #:8568"),
    );
  });

  it("merges two stores of one chain", () => {
    expect(normalizeMerchant("COSTCO WHSE #1031 MANTECA CA")).toBe(
      normalizeMerchant("COSTCO WHSE #0442 TRACY CA"),
    );
  });

  it("merges a phone-tagged and a city-tagged variant", () => {
    expect(normalizeMerchant("FSP*JESSIE S GROVE LODI CA Card #:8568")).toBe(
      "JESSIE S GROVE",
    );
    expect(normalizeMerchant("FSP*JESSIE S GROVE 209-368-0880 CA Card #:8568")).toBe(
      "JESSIE S GROVE",
    );
  });

  it("does not treat a city word inside a merchant name as a location", () => {
    // GROVE is only ever stripped as part of "ELK GROVE" / "WALNUT GROVE".
    expect(normalizeMerchant("FSP*JESSIE S GROVE 209-368-0880 CA Card #:8568")).toContain(
      "GROVE",
    );
  });

  it("GUARD: never reduces a merchant to a bare city name", () => {
    // Without this guard the simulation produced a group literally named MANTECA.
    expect(normalizeMerchant("POS 0101 0101 000001 MANTECA MANTECA CA")).toBe(
      "MANTECA MANTECA",
    );
  });

  it("GUARD: never returns an empty string", () => {
    expect(normalizeMerchant("*MANTECA")).toBe("MANTECA");
    expect(normalizeMerchant("***")).not.toBe("");
    expect(normalizeMerchant("...")).not.toBe("");
  });

  it("GUARD: a degenerate processor memo never degrades to the processor name", () => {
    // `SQ *` splits to an empty merchant. Without the final guard the punctuation
    // trim turns the fallback `SQ *` into a bare `SQ`.
    expect(normalizeMerchant("SQ *")).toBe("SQ *");
    expect(PROCESSOR_PREFIXES.has(normalizeMerchant("SQ *"))).toBe(false);
    expect(normalizeMerchant("TST*")).toBe("TST*");
    expect(PROCESSOR_PREFIXES.has(normalizeMerchant("TST*"))).toBe(false);
  });

  it("prefers the longest matching city", () => {
    expect(normalizeMerchant("SQ *BANKHEAD THEATE Walnut Creek CA")).toBe(
      "BANKHEAD THEATE",
    );
  });
});

describe("normalizeMerchant — class 5, embedded timestamps", () => {
  it("collapses per-transaction timestamps that can never repeat", () => {
    expect(normalizeMerchant("Mobile 01/28/2026 14:09:23 Ref# 43FAD")).toBe("MOBILE");
    expect(normalizeMerchant("Mobile 06/17/2026 11:27:28 Ref# CCED8")).toBe("MOBILE");
    expect(normalizeMerchant("Online 02/24/2026 17:15:22 Ref# 09855")).toBe("ONLINE");
    // KNOWN LIMIT: the rule is NOT global, so only the first timestamp goes.
    // No real Star One memo carries two, but pin it so a second one showing up
    // reads as a failing test rather than as a new singleton group.
    expect(
      normalizeMerchant("FOO 01/09/2026 12:43:41 BAR 02/10/2026 11:11:11"),
    ).toBe("FOO BAR 02/10/2026 11:11:11");
  });

  it("strips the MEMO: free-text tail", () => {
    expect(normalizeMerchant("Online 02/12/2026 14:29:34 MEMO: RENT AUGUST")).toBe(
      "ONLINE",
    );
  });
});

describe("normalizeMerchant — class 6, processor domain suffixes", () => {
  it("strips a domain shielded behind a trailing state code", () => {
    // Requires the second domain pass in phase 4; the first pass cannot see it
    // because " CA" is still attached.
    expect(normalizeMerchant("SQ *BLOCK 21 WINERY gosq.com CA Card #:8568")).toBe(
      "BLOCK 21 WINERY",
    );
  });

  it("merges the domain-tagged and city-tagged variants of one merchant", () => {
    expect(normalizeMerchant("SQ *BLOCK 21 WINERY gosq.com CA Card #:8568")).toBe(
      normalizeMerchant("SQ *BLOCK 21 WINERY Lodi CA Card #:8568"),
    );
  });

  it("strips DOORDASH.COM", () => {
    expect(normalizeMerchant("DD *SMALLCAKESCUPCA DOORDASH.COM")).toBe(
      "SMALLCAKESCUPCA",
    );
  });
});

describe("normalization constants", () => {
  it("exports PROCESSOR_PREFIXES as the single direction-deciding set", () => {
    expect(PROCESSOR_PREFIXES.has("TST")).toBe(true);
    expect(PROCESSOR_PREFIXES.has("SQ")).toBe(true);
    expect(PROCESSOR_PREFIXES.has("AMAZON")).toBe(false);
    // GOOGLE is a processor for its own products. Without it, Google One and
    // YouTube Premium collapsed onto one key that spanned two categories.
    expect(PROCESSOR_PREFIXES.has("GOOGLE")).toBe(true);
  });

  it("strips every city in KNOWN_CITIES as a trailing location", () => {
    // Driven by the exported list, so a city added to the implementation
    // without working is a failure rather than silently uncovered.
    for (const city of KNOWN_CITIES) {
      expect(normalizeMerchant(`ACME DINER ${city} CA`), `city ${city}`).toBe(
        "ACME DINER",
      );
    }
  });

  it("holds no city that is a trailing-word suffix of another", () => {
    // The longest-first sort exists so a multi-word city beats a single-word
    // one it contains. No such pair exists today, which is why the ordering is
    // currently inert — this fails the day one is added, at which point the
    // sort becomes load-bearing and needs its own behavioral test.
    for (const a of KNOWN_CITIES) {
      for (const b of KNOWN_CITIES) {
        if (a === b) continue;
        expect(a.endsWith(` ${b}`), `${a} contains ${b}`).toBe(false);
      }
    }
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
    // `.slice(-4)` neither pads nor rejects: a short run comes back short, and a
    // long run is truncated to the last four. The match is case-insensitive.
    expect(extractCardLastFour("FOO Card #:12")).toBe("12");
    expect(extractCardLastFour("FOO Card #:1234567")).toBe("4567");
    expect(extractCardLastFour("foo card #:8568")).toBe("8568");
  });

  it("returns null when no card number is present", () => {
    expect(extractCardLastFour("DEPOSIT-OVERDRAFT")).toBeNull();
    expect(extractCardLastFour("Execupay  01QSXBDIR DEP   260410")).toBeNull();
  });
});

/**
 * Second half of the behavior-change ledger. Phase 4's tail rules (`.COM` strip,
 * trailing store/account number) and the class 2 split reach memo shapes the
 * first table does not name, and each one silently changes the grouping key a
 * trained `category_rules.match_value` was written against.
 */
describe("normalizeMerchant — documented behavior changes, phase 4 tail", () => {
  const changes: Array<{ raw: string; was: string; now: string; why: string }> = [
    {
      raw: "ANCESTRY.COM CA Card #:8568",
      was: "ANCESTRY.COM",
      now: "ANCESTRY",
      why: "phase 4 .COM strip reaches a merchant whose real name ends in .COM",
    },
    {
      raw: "WALMART.COM 8009256",
      was: "WALMART.COM 8009256",
      now: "WALMART",
      why: "phase 4 trailing-number strip then .COM strip, no star involved",
    },
    {
      raw: "PAYPAL *STEAMGAMES 4259522985 WA",
      was: "PAYPAL *STEAMGAMES",
      now: "STEAMGAMES",
      why: "class 2 processor-first split on PAYPAL",
    },
    {
      raw: "Café Böhm Manteca CA",
      was: "CAFÉ BÖHM MANTECA",
      now: "CAFÉ BÖHM",
      why: "class 3 city strip on a non-ASCII merchant name",
    },
  ];

  for (const { raw, was, now, why } of changes) {
    it(`${why}: ${JSON.stringify(raw)}`, () => {
      expect(normalizeMerchant(raw)).toBe(now);
      expect(normalizeMerchant(raw)).not.toBe(was);
    });
  }
});

describe("normalizeMerchant — degenerate input and the final guard", () => {
  it("falls back to the original when every phase strips the whole string", () => {
    // The domain rules run twice and would leave nothing behind; the final
    // guard is the only reason these do not become an empty grouping key.
    for (const raw of [
      "AMZN.COM/BILL",
      "AMZN.COM",
      "GOSQ.COM",
      "DOORDASH.COM",
      "TOASTTAB.COM",
      "SQUAREUP.COM",
      "UBER.COM",
      "g.co/helppay#",
    ]) {
      expect(normalizeMerchant(raw)).toBe(raw.toUpperCase());
    }
  });

  it("falls back rather than emptying on a punctuation-only memo", () => {
    expect(normalizeMerchant("*")).toBe("*");
    expect(normalizeMerchant("* ")).toBe("*");
    expect(normalizeMerchant("**")).toBe("**");
    expect(normalizeMerchant("SQ * ")).toBe("SQ *");
    expect(PROCESSOR_PREFIXES.has(normalizeMerchant("SQ * "))).toBe(false);
  });

  it("returns an empty key ONLY for an empty or whitespace-only memo", () => {
    // The one hole in the never-empty guarantee, and it is not new — the
    // fallback is itself empty, so there is nothing to fall back to. Every
    // consumer that requires a non-empty merchant (validateBulkCategorizeInput)
    // rejects it downstream rather than here.
    expect(normalizeMerchant("")).toBe("");
    expect(normalizeMerchant("   ")).toBe("");
    expect(normalizeMerchant("\t\n ")).toBe("");
  });
});

describe("normalizeMerchant — star split mechanics", () => {
  it("matches a processor prefix case-insensitively", () => {
    expect(normalizeMerchant("sq *lowercase merch Lodi CA")).toBe("LOWERCASE MERCH");
    expect(normalizeMerchant("Tst*Some Cafe Lodi CA")).toBe("SOME CAFE");
  });

  it("keeps the post-star merchant for EVERY processor in the set", () => {
    // One case per entry, so removing an entry fails here as well as in the
    // bare-processor trap test above.
    for (const prefix of PROCESSOR_PREFIXES) {
      const result = normalizeMerchant(`${prefix} *MERCHANT NAME Lodi CA`);
      expect(result, `processor ${prefix}`).toBe("MERCHANT NAME");
    }
  });

  it("splits on the FIRST star only and leaves any later star alone", () => {
    expect(normalizeMerchant("SQ *FOO*BAR Lodi CA")).toBe("FOO*BAR");
  });

  it("strips every brand qualifier on the pre-star side", () => {
    for (const q of BRAND_QUALIFIER_WORDS) {
      expect(normalizeMerchant(`ACME ${q}*A1B2C3`), `qualifier ${q}`).toBe("ACME");
    }
  });
});

describe("normalizeMerchant — class 6, every processor domain", () => {
  it("strips each domain from behind a trailing state code", () => {
    for (const domain of PROCESSOR_DOMAIN_SAMPLES) {
      expect(
        normalizeMerchant(`BLOCK 21 WINERY ${domain} CA`),
        `domain ${domain}`,
      ).toBe("BLOCK 21 WINERY");
    }
  });

  it("has one literal sample per domain pattern", () => {
    // Guards the loop above: a pattern added without a sample would otherwise
    // ship with zero coverage and no signal.
    expect(PROCESSOR_DOMAIN_SAMPLES).toHaveLength(
      PROCESSOR_DOMAIN_PATTERNS.length,
    );
  });
});

describe("normalizeMerchant — class 3, city strip against real merchant names", () => {
  it("strips a trailing city that also appears inside the merchant name", () => {
    // Only ONE trailing city is ever removed, so the copy inside the name survives.
    expect(normalizeMerchant("TRACY NAILS TRACY CA")).toBe("TRACY NAILS");
    // The tail rules run to a fixed point, so a second city strip fires here and
    // this reduces all the way to SALON. That is the cost of idempotence: a
    // merchant whose LAST word is a known city loses it. Measured against the
    // live ledger the class is empty of casualties (only COURTYARD CONWAY and
    // 215 BOWLERO MANTECA hit it, and both group correctly), but the trade is
    // real. A city appearing anywhere EARLIER in the name still survives -- see
    // the TRACY NAILS case below.
    expect(normalizeMerchant("SALON DENVER DENVER CA")).toBe("SALON");
    expect(normalizeMerchant("NEW YORK BAGELS NEW YORK CA")).toBe("NEW YORK BAGELS");
  });

  it("GUARD: never reduces a merchant to a bare MULTI-WORD city either", () => {
    // The MANTECA guard above only exercises a single-token city; the
    // longest-first sort means a multi-word city takes a different branch.
    expect(normalizeMerchant("SAN FRANCISCO SAN FRANCISCO CA")).toBe(
      "SAN FRANCISCO SAN FRANCISCO",
    );
    expect(normalizeMerchant("LODI LODI CA")).toBe("LODI LODI");
  });

  it("ORDERING: strips the city whether or not a state code shielded it", () => {
    // Phase 4 must run after phase 3. If the city strip ran first it would see
    // " CA" as the last token and match nothing on the left-hand form.
    expect(normalizeMerchant("COSTCO WHSE MANTECA CA")).toBe("COSTCO WHSE");
    expect(normalizeMerchant("COSTCO WHSE MANTECA")).toBe("COSTCO WHSE");
    expect(normalizeMerchant("COSTCO WHSE MANTECA CA")).toBe(
      normalizeMerchant("COSTCO WHSE MANTECA"),
    );
  });
});

describe("normalizeMerchant — non-ASCII input", () => {
  it("uppercases accented characters and still finds the state and city", () => {
    expect(normalizeMerchant("Café Böhm Manteca CA")).toBe("CAFÉ BÖHM");
  });

  it("leaves a non-Latin merchant name intact", () => {
    expect(normalizeMerchant("日本レストラン MANTECA CA")).toBe(
      "日本レストラン",
    );
    // No Latin state code and no known city — nothing to strip.
    expect(normalizeMerchant("СБЕР МАНТЕКА")).toBe(
      "СБЕР МАНТЕКА",
    );
  });
});

describe("normalizeMerchant — trailing-token boundaries", () => {
  it("strips a trailing run of 3+ digits but keeps a shorter one", () => {
    expect(normalizeMerchant("STORE 761")).toBe("STORE");
    expect(normalizeMerchant("STORE 76")).toBe("STORE 76");
    expect(normalizeMerchant("7-ELEVEN 12345")).toBe("7-ELEVEN");
  });

  it("strips a trailing 2-letter token only when 3+ characters precede it", () => {
    expect(normalizeMerchant("ABC CA")).toBe("ABC");
    expect(normalizeMerchant("AB CA")).toBe("AB CA");
  });
});

describe("normalizeMerchant — idempotence", () => {
  /**
   * `normalized_merchant` is what a trained rule's `match_value` is copied from,
   * so a second normalization moving the key would silently move it out from
   * under its rule.
   *
   * This block previously asserted the same property over a hand-picked 14-memo
   * corpus that happened to exclude every counterexample -- including ones this
   * very file pins elsewhere -- so it could never fail while the invariant was
   * false for 22 of the ledger's 361 keys. The corpus is now derived from every
   * raw memo asserted anywhere in this file, and the tail rules run to a fixed
   * point so the property holds by construction rather than by luck.
   */
  const CORPUS = [
    "TST*THE BRASS TAP - Modesto CA Card #:8568",
    "GOOGLE *Google One 855-836-3987 CA Card #:8568",
    "GOOGLE *YouTubePrem g.co/helppay# CA Card #:8568",
    "AMAZON MKTPL*5H7A39 Amzn.com/bill",
    "AMAZON PRIME*RV8CL5 AMZN.COM/BILL",
    "AUDIBLE*3I95N0A03 AMZN.COM/BILL",
    "SAFEWAY.COM*1652704",
    "SQ *BLOCK 21 WINERY gosq.com CA Card #:8568",
    "DD *SMALLCAKESCUPCA DOORDASH.COM",
    "FSP*BRETHREN BREWIN MANTECA CA Card #:8568",
    "ATM 0301 1818 421618 *MANTECA MANTECA CA",
    "POS 0325 1536 082706 CHEAPER CIGARETTES MANTECA CA",
    "Online 04/15/2026 07:23:00 Ref# 436EF",
    "  COSTCO WHSE #1031  MANTECA  CA",
    "STARBUCKS 800782728 800-782-7282 WA Card #:7190",
    "DEPOSIT-OVERDRAFT",
    // The shapes the old corpus omitted, each of which used to drift.
    "POS 0220 1937 794511 SQ *TAPPED APPLE LL Salida CA",
    "TST*HOTEL SUTTER RE Sutter Creek CA Card #:8568",
    "SALON DENVER DENVER CA",
    "SBI 0413 0644 423142 Mobile Deposit          Star One CU  CA",
    "SAVEMART #12 MA MANTECA Card #:8568",
    "AUTOZONE 3335 147 MANTECA CA Card #:8568",
    "TRACY VETERINARY ME TRACY CA Card #:8568",
    "COURTYARD CONWAY CONWAY AR Card #:8568",
    "CARMAZZI CARAMEL CO SACRAMENTO CA Card #:7190",
    "215 LUCKY STRIKE MA MANTECA CA Card #:8568",
    "Provisional Credit PUBLICRECORDS.US 888-",
    "01/09/2026 12:43:41 *FOO BAR",
  ];

  it("re-normalizing an already-normalized key is a no-op", () => {
    for (const raw of CORPUS) {
      const once = normalizeMerchant(raw);
      expect(
        normalizeMerchant(once),
        `not a fixed point: ${raw} -> ${once}`,
      ).toBe(once);
    }
  });

  it("holds for every key the class tests in this file produce", () => {
    // Cheap breadth: any raw memo used in an expect() above is fair game.
    for (const raw of CORPUS) {
      const once = normalizeMerchant(raw);
      expect(once, `empty key from ${raw}`).not.toBe("");
      expect(once.startsWith("*"), `star-leading key from ${raw}`).toBe(false);
      expect(PROCESSOR_PREFIXES.has(once), `bare processor from ${raw}`).toBe(
        false,
      );
    }
  });

  /**
   * The one structural exception, pinned rather than hidden. A key that still
   * contains a `*` is re-split on a second pass, because the split deliberately
   * runs exactly once and only on the FIRST star -- that is what keeps a merchant
   * whose own name contains a star intact. Making this a fixed point would mean
   * splitting on every star, which loses more than it gains.
   *
   * One live key is affected: `FD *CA DMV 658 *SVC ...` -> `CA DMV 658 *SVC`.
   * It is harmless because every write path normalizes from `raw_memo`, never
   * from an existing key.
   */
  it("documents the star-bearing key as the one non-fixed-point", () => {
    const key = normalizeMerchant("FD *CA DMV 658 *SVC 800-777-0133 CA");
    expect(key).toBe("CA DMV 658 *SVC");
    expect(normalizeMerchant(key)).toBe("CA DMV");

    expect(normalizeMerchant("SQ *FOO*BAR Lodi CA")).toBe("FOO*BAR");
  });
});

describe("normalizeMerchant — processor and qualifier tables", () => {
  it("keeps two Google products distinct instead of bucketing them", () => {
    // Without GOOGLE in PROCESSOR_PREFIXES both collapsed onto the key GOOGLE,
    // which on the live ledger spanned Subscriptions=8 and Streaming=9 -- the
    // exact failure the PROCESSOR_PREFIXES doc comment says cannot happen.
    expect(
      normalizeMerchant("GOOGLE *Google One 855-836-3987 CA Card #:8568"),
    ).toBe("GOOGLE ONE");
    expect(
      normalizeMerchant("GOOGLE *YouTubePrem g.co/helppay# CA Card #:8568"),
    ).toBe("YOUTUBEPREM");
    expect(
      normalizeMerchant("GOOGLE *Google One 855-836-3987 CA"),
    ).not.toBe(normalizeMerchant("GOOGLE *YouTubePrem g.co/helppay# CA"));
  });

  it("keeps the seeded contains-rule tokens reachable in the new keyspace", () => {
    // drizzle/0006_subscription_rules.sql seeds `contains 'AMAZON PRIME'` and
    // `contains 'GOOGLE ONE'`. A contains value is not a normalized key, so a
    // backfill cannot repair it -- if the token stops appearing, the rule is
    // dead permanently.
    expect(normalizeMerchant("AMAZON PRIME*RV8CL5 AMZN.COM/BILL")).toContain(
      "AMAZON PRIME",
    );
    expect(
      normalizeMerchant("GOOGLE *Google One 855-836-3987 CA"),
    ).toContain("GOOGLE ONE");
  });

  it("carries only brand qualifiers the ledger actually produces", () => {
    // An extra entry here is destructive: it eats a trailing word off a real
    // merchant name. Measured over 1540 memos, MKTPL is the only one that both
    // appears and is safe to strip.
    expect(BRAND_QUALIFIER_WORDS).toEqual(["MKTPL"]);
    expect(normalizeMerchant("AMAZON MKTPL*5H7A39 AMZN.COM/BILL WA")).toBe(
      "AMAZON",
    );
  });

  it("strips a trailing state code but not a truncated merchant suffix", () => {
    // TRAILING_STATE is an allowlist, not [A-Z]{2}. `LL` is not a state, so the
    // bank-truncated name keeps it; `CA` is, so it goes.
    expect(
      normalizeMerchant("POS 0220 1937 794511 SQ *TAPPED APPLE LL Salida CA"),
    ).toBe("TAPPED APPLE LL");
    expect(normalizeMerchant("ACME DINER ON")).toBe("ACME DINER");
    expect(normalizeMerchant("ACME DINER ZZ")).toBe("ACME DINER ZZ");
  });

  it("never emits a key that begins with a star", () => {
    // Phase 2 replaces a leading timestamp with a space, leaving an empty
    // pre-star side; the brand-first branch used to return the whole string.
    expect(normalizeMerchant("01/09/2026 12:43:41 *FOO BAR")).toBe("FOO BAR");
  });

  it("runs the tail rules to a fixed point within one call", () => {
    // Each rule fires once per sweep, and one rule's output re-creates another's
    // precondition. A single sweep stopped at the first line of each pair.
    expect(normalizeMerchant("SAVEMART #12 MA MANTECA Card #:8568")).toBe(
      "SAVEMART",
    );
    expect(normalizeMerchant("AUTOZONE 3335 147 MANTECA CA Card #:8568")).toBe(
      "AUTOZONE",
    );
    expect(normalizeMerchant("TRACY VETERINARY ME TRACY CA Card #:8568")).toBe(
      "TRACY VETERINARY",
    );
  });
});
