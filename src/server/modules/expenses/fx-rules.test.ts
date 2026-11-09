import { describe, expect, it } from "vitest";
import { convertToInr, parseRateMicro, rateFor, ratesFromProvider, rateText } from "./fx-rules";

describe("exchange rates", () => {
  it("parses rates to millionths and back", () => {
    expect(parseRateMicro("83.25")).toBe(83_250_000);
    expect(parseRateMicro("83.254321")).toBe(83_254_321);
    expect(parseRateMicro("1,234.5")).toBe(1_234_500_000);
    expect(parseRateMicro("0.5678901")).toBeNull();   // more than 6 decimals
    expect(parseRateMicro("0")).toBeNull(); expect(parseRateMicro("-1")).toBeNull(); expect(parseRateMicro("abc")).toBeNull();
    expect(rateText(83_250_000)).toBe("83.25"); expect(rateText(83_254_321)).toBe("83.254321"); expect(rateText(90_000_000)).toBe("90.00");
  });
  it("converts foreign minor units to paise with exact integer maths, half up", () => {
    expect(convertToInr(10_000, 83_250_000)).toBe(832_500);        // USD 100.00 → ₹8,325.00
    expect(convertToInr(1, 83_254_321)).toBe(83);                   // 1 cent → 83.25 paise → 83
    expect(convertToInr(3, 83_254_321)).toBe(250);                  // 249.76 → 250
    expect(convertToInr(0, 83_254_321)).toBe(0);
    expect(() => convertToInr(1.5, 1)).toThrow(); expect(() => convertToInr(1, 0)).toThrow();
  });
  it("picks the latest rate on or before the date, else the earliest later one", () => {
    const rates = [
      { currency: "USD", asOf: "2026-09-01", rateMicro: 83_000_000, source: "manual" as const },
      { currency: "USD", asOf: "2026-09-10", rateMicro: 84_000_000, source: "fetched" as const },
      { currency: "EUR", asOf: "2026-09-05", rateMicro: 90_000_000, source: "manual" as const },
    ];
    expect(rateFor(rates, "USD", "2026-09-12")?.rateMicro).toBe(84_000_000);
    expect(rateFor(rates, "USD", "2026-09-05")?.rateMicro).toBe(83_000_000);
    expect(rateFor(rates, "EUR", "2026-01-01")?.rateMicro).toBe(90_000_000);
    expect(rateFor(rates, "GBP", "2026-09-12")).toBeNull();
  });
  it("turns a provider's quote into INR-per-unit rows, whatever its base", () => {
    expect(ratesFromProvider({ base: "INR", rates: { USD: 0.012, EUR: 0.011, INR: 1, xx: 2 } }, "2026-09-10")).toEqual([
      { currency: "USD", asOf: "2026-09-10", rateMicro: 83_333_333, source: "fetched" }, { currency: "EUR", asOf: "2026-09-10", rateMicro: 90_909_091, source: "fetched" },
    ]);
    expect(ratesFromProvider({ base: "USD", rates: { INR: 83.5, EUR: 0.92 } }, "2026-09-10")).toEqual([{ currency: "EUR", asOf: "2026-09-10", rateMicro: 90_760_870, source: "fetched" }]);
    expect(ratesFromProvider({ base: "USD", rates: { EUR: 0.92 } }, "2026-09-10")).toEqual([]);
    expect(ratesFromProvider(null, "2026-09-10")).toEqual([]);
  });
});
