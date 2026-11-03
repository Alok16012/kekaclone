import { describe, expect, it } from "vitest";
import { accentProblem, brandingCss, contrast, derivePalette, hexToRgb } from "./branding-rules";

describe("branding", () => {
  it("validates hex and contrast against white", () => {
    expect(accentProblem("blue")).toMatch(/hex/);
    expect(accentProblem("#ffff00")).toMatch(/contrast/);      // yellow: white text unreadable
    expect(accentProblem("#2f5bea")).toBeNull();
    expect(accentProblem("#0b3d91")).toBeNull();
    expect(contrast(hexToRgb("#000000")!, hexToRgb("#ffffff")!)).toBeCloseTo(21, 0);
  });
  it("derives readable text shades and emits CSS only for valid accents", () => {
    const p = derivePalette("#1b7f4c", "light");
    expect(contrast(hexToRgb(p.text)!, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    const d = derivePalette("#1b7f4c", "dark");
    expect(contrast(hexToRgb(d.text)!, [0x15, 0x19, 0x20])).toBeGreaterThanOrEqual(4.5);
    expect(brandingCss({ accent: "#1b7f4c" })).toContain("--accent:#1b7f4c");
    expect(brandingCss({ accent: "#1b7f4c" })).toContain('[data-theme="dark"]');
    expect(brandingCss({ accent: "#ffff00" })).toBe("");
    expect(brandingCss(null)).toBe("");
  });
});
