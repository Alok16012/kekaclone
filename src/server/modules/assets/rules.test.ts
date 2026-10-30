import { describe, expect, it } from "vitest";
import { afterReturn, canAssign, checkRecovery, formatPaise, normaliseTag, rupeesToPaise, suggestedRecovery, totalRecovery } from "./rules";

const P = (n: number | string) => BigInt(n);

describe("money: rupees ↔ paise without floating point", () => {
  it("parses rupee amounts exactly", () => {
    expect(rupeesToPaise("0")).toBe(P(0));
    expect(rupeesToPaise("1")).toBe(P(100));
    expect(rupeesToPaise("0.1")).toBe(P(10));
    expect(rupeesToPaise("0.29")).toBe(P(29));            // 0.29 * 100 is 28.999… in floats
    expect(rupeesToPaise("1,23,456.5")).toBe(P(12345650));
    expect(rupeesToPaise("₹ 85,000")).toBe(P(8500000));
    expect(rupeesToPaise("12.")).toBe(P(1200));
    expect(rupeesToPaise("999999999999.99")).toBe(P("99999999999999"));
  });
  it("rejects blanks, negatives, extra decimals and junk", () => {
    for (const bad of ["", " ", "-5", "1.234", "abc", "1e5", "12.3.4"]) expect(rupeesToPaise(bad)).toBeNull();
  });
  it("formats paise in Indian grouping", () => {
    expect(formatPaise(P(0))).toBe("0.00");
    expect(formatPaise(P(5))).toBe("0.05");
    expect(formatPaise(P(12345650))).toBe("1,23,456.50");
    expect(formatPaise(P("1000000000"))).toBe("1,00,00,000.00");
    expect(formatPaise(P(-250))).toBe("-2.50");
  });
  it("round-trips", () => {
    for (const s of ["0.01", "7.5", "45,999.99", "1,00,00,000.00"]) expect(formatPaise(rupeesToPaise(s)!)).toBe(formatPaise(rupeesToPaise(formatPaise(rupeesToPaise(s)!))!));
  });
  it("sums recovery exactly (golden)", () => {
    const rows = [{ recovery_paise: P(150050) }, { recovery_paise: "2999" }, { recovery_paise: 1 }, { recovery_paise: P("9007199254740993") }];
    expect(totalRecovery(rows)).toBe(P("9007199254894043"));
    expect(totalRecovery([])).toBe(P(0));
  });
});

describe("recovery rules", () => {
  it("only on damaged or lost, never negative, capped at cost", () => {
    expect(checkRecovery("damaged", P(5000), P(80000))).toEqual({ ok: true, paise: P(5000) });
    expect(checkRecovery("lost", P(80000), P(80000))).toEqual({ ok: true, paise: P(80000) });
    expect(checkRecovery("good", P(0), P(80000)).ok).toBe(true);
    expect(checkRecovery("good", P(1), P(80000)).ok).toBe(false);
    expect(checkRecovery("damaged", P(-1), null).ok).toBe(false);
    const over = checkRecovery("lost", P(80001), P(80000));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("800.00");
    expect(checkRecovery("lost", P(99999999), null).ok).toBe(true);   // no cost on record → no cap
  });
  it("suggests the full cost for a lost asset", () => {
    expect(suggestedRecovery("lost", P(6500000))).toBe(P(6500000));
    expect(suggestedRecovery("damaged", P(6500000))).toBe(P(0));
    expect(suggestedRecovery("lost", null)).toBe(P(0));
  });
});

describe("asset states", () => {
  it("only available, usable assets can be handed over", () => {
    expect(canAssign({ status: "available", condition: "good" }).ok).toBe(true);
    expect(canAssign({ status: "available", condition: "new" }).ok).toBe(true);
    expect(canAssign({ status: "assigned", condition: "good" }).ok).toBe(false);
    expect(canAssign({ status: "in_repair", condition: "fair" }).ok).toBe(false);
    expect(canAssign({ status: "retired", condition: "good" }).ok).toBe(false);
    expect(canAssign({ status: "available", condition: "damaged" }).ok).toBe(false);
  });
  it("returns: lost → retired, damaged → repair, otherwise available", () => {
    expect(afterReturn("lost")).toEqual({ status: "retired", condition: "lost" });
    expect(afterReturn("damaged")).toEqual({ status: "in_repair", condition: "damaged" });
    expect(afterReturn("fair")).toEqual({ status: "available", condition: "fair" });
  });
  it("normalises tags", () => {
    expect(normaliseTag(" lap-0012 ")).toBe("LAP-0012");
    expect(normaliseTag("ID/22")).toBe("ID/22");
    expect(normaliseTag("x")).toBeNull();
    expect(normaliseTag("-bad")).toBeNull();
    expect(normaliseTag("has space")).toBeNull();
  });
});
