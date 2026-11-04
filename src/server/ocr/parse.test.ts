import { describe, expect, it } from "vitest";
import { parseAmount, parseDate, parseMerchant, parseReceipt, scaleConfidence } from "./parse";

const RECEIPT = `CAFE AROMA
12, MG Road, Bengaluru
GSTIN 29ABCDE1234F1Z5
Date: 14/09/2026  Time: 13:42
Bill No: 4471
2 x Cappuccino        360.00
1 x Sandwich          220.00
Sub Total             580.00
CGST 2.5%              14.50
SGST 2.5%              14.50
Grand Total        Rs. 609.00
Thank you, visit again`;

describe("receipt parsing", () => {
  it("finds the grand total rather than the sub total or taxes", () => {
    expect(parseAmount(RECEIPT)).toEqual({ amountPaise: 60_900, confidence: 90 });
  });
  it("takes the figure from the next line when TOTAL stands alone, and falls back to the largest marked amount", () => {
    expect(parseAmount("Items\nTOTAL\n1,250.00")).toEqual({ amountPaise: 125_000, confidence: 75 });
    expect(parseAmount("Milk 45\nBread ₹ 60\nEggs ₹120")).toEqual({ amountPaise: 12_000, confidence: 50 });
    expect(parseAmount("Milk 45.00\nBread 60.00")).toEqual({ amountPaise: 6_000, confidence: 30 });
    expect(parseAmount("no money here")).toBeNull();
  });
  it("reads Indian day-first dates and month names", () => {
    expect(parseDate(RECEIPT)).toEqual({ date: "2026-09-14", confidence: 85 });
    expect(parseDate("Dated 03/04/2026")).toEqual({ date: "2026-04-03", confidence: 60 });   // ambiguous: day first, lower confidence
    expect(parseDate("2026-03-12")).toEqual({ date: "2026-03-12", confidence: 85 });
    expect(parseDate("12 Mar 2026")).toEqual({ date: "2026-03-12", confidence: 80 });
    expect(parseDate("March 12, 2026")).toEqual({ date: "2026-03-12", confidence: 75 });
    expect(parseDate("13/13/2026")).toBeNull();
    expect(parseDate("31-02-26")).toBeNull();
  });
  it("takes the first real name line as the merchant", () => {
    expect(parseMerchant(RECEIPT)).toEqual({ merchant: "CAFE AROMA", confidence: 70 });
    expect(parseMerchant("TAX INVOICE\nGSTIN 29ABCDE1234F1Z5\nBlue Cab Services\n")?.merchant).toBe("Blue Cab Services");
    expect(parseMerchant("123456\n14/09/2026")).toBeNull();
  });
  it("combines the guesses and scales confidence by the engine's own", () => {
    const g = parseReceipt(RECEIPT);
    expect(g).toEqual({ amountPaise: 60_900, date: "2026-09-14", merchant: "CAFE AROMA", confidence: { amount: 90, date: 85, merchant: 70 } });
    expect(scaleConfidence(g, 50).confidence).toEqual({ amount: 68, date: 64, merchant: 53 });
    expect(scaleConfidence(g, 100).confidence).toEqual(g.confidence);
    expect(parseReceipt("")).toEqual({ amountPaise: null, date: null, merchant: null, confidence: { amount: 0, date: 0, merchant: 0 } });
  });
});
