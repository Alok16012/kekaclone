import { describe, expect, it } from "vitest";
import { evaluate, parseDecimal, parseFormula, rat, roundHalfUp, roundTo, type Rat } from "./formula";

const val = (src: string, vars: Record<string, string> = {}) => {
  const r = parseFormula(src);
  if (!r.ok) throw new Error(r.error);
  const v = evaluate(r.ast, (c) => parseDecimal(vars[c] ?? "0")!);
  return `${v.n}/${v.d}`;
};
const err = (src: string) => { const r = parseFormula(src); return r.ok ? null : r.error; };

describe("parseFormula", () => {
  it("reads references, numbers, operators, functions and parentheses", () => {
    const r = parseFormula("max([BASIC] * 0.4, min([ctc], 15000)) + ([HRA] - 2) / 3");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.refs.sort()).toEqual(["BASIC", "CTC", "HRA"]);
  });
  it("respects precedence and associativity", () => {
    expect(val("2 + 3 * 4")).toBe("14/1");
    expect(val("(2 + 3) * 4")).toBe("20/1");
    expect(val("10 - 4 - 3")).toBe("3/1");
    expect(val("100 / 10 / 5")).toBe("2/1");
    expect(val("-[A] + 5", { A: "2" })).toBe("3/1");
    expect(val("--3")).toBe("3/1");
  });
  it("is exact: no floating-point drift", () => {
    expect(val("0.1 + 0.2")).toBe("3/10");
    expect(val("[B] * 0.12", { B: "15000" })).toBe("1800/1");
    expect(val("1 / 3 * 3")).toBe("1/1");
  });
  it("min, max and round", () => {
    expect(val("min([B], 15000)", { B: "21000" })).toBe("15000/1");
    expect(val("max(1, 2, 3)")).toBe("3/1");
    expect(val("round(2.5)")).toBe("3/1");
    expect(val("round(-2.5)")).toBe("-3/1");
    expect(val("round(1234.567, 2)")).toBe("123457/100");
    expect(val("round(1250, -2)")).toBe("1300/1");
    expect(val("ROUND(2.4)")).toBe("2/1");
  });
  it("refuses anything that isn't the formula language (no eval, no identifiers)", () => {
    expect(err("")).toMatch(/Enter a formula/);
    expect(err("process.exit()")).not.toBeNull();
    expect(err("eval(1)")).toMatch(/isn't something formulas know/);
    expect(err("[BASIC] ** 2")).toMatch(/out of place/);
    expect(err("[BASIC")).toMatch(/closing/);
    expect(err("[bad code!]")).toMatch(/isn't a component code/);
    expect(err("1 +")).toMatch(/ends too early/);
    expect(err("(1 + 2")).toMatch(/Expected "\)"/);
    expect(err("min(1)")).toMatch(/at least two/);
    expect(err("round(1, 2, 3)")).toMatch(/round\(\)/);
    expect(err("round(1, [X])")).toMatch(/decimals/);
    expect(err("1.2.3")).toMatch(/isn't a number/);
    expect(err("1; 2")).toMatch(/can't be used/);
    expect(err("`x`")).toMatch(/can't be used/);
    expect(err("1 2")).toMatch(/out of place/);
    expect(err("(".repeat(60) + "1" + ")".repeat(60))).toMatch(/nested too deeply/);
    expect(err("1+".repeat(300) + "1")).toMatch(/under 500/);
  });
  it("reports division by zero when evaluated", () => {
    expect(() => val("[A] / [B]", { A: "1", B: "0" })).toThrow(/Division by zero/);
  });
});

describe("rationals", () => {
  const r = (s: string): Rat => parseDecimal(s)!;
  it("parses decimals exactly and refuses floats in other notations", () => {
    expect(parseDecimal("50.0000")).toEqual(rat(BigInt(50)));
    expect(parseDecimal("-0.125")).toEqual(rat(-BigInt(1), BigInt(8)));
    expect(parseDecimal("1e5")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
  it("rounds half away from zero", () => {
    expect(roundHalfUp(r("0.5"))).toBe(BigInt(1));
    expect(roundHalfUp(r("0.49"))).toBe(BigInt(0));
    expect(roundHalfUp(r("-0.5"))).toBe(-BigInt(1));
    expect(roundTo(r("12.345"), 2)).toEqual(r("12.35"));
  });
});
