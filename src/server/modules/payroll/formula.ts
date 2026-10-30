/**
 * Salary formula language (pure, no I/O, no eval). Shared by the server and the structure editor's live preview.
 *
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/") unary)*
 *   unary      := "-" unary | primary
 *   primary    := number | "[" CODE "]" | fn "(" expression ("," expression)* ")" | "(" expression ")"
 *   fn         := min | max | round        (case-insensitive)
 *
 * Values are rupees. Arithmetic is exact: every value is a fraction of two BigInts, so 0.1 + 0.2 is exactly 0.3
 * and the same inputs always give the same paise. Rounding only happens where the caller (or round()) says.
 */

export type Rat = { n: bigint; d: bigint };   // d > 0, reduced

export type Node =
  | { t: "num"; v: Rat }
  | { t: "ref"; code: string }
  | { t: "neg"; x: Node }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { t: "fn"; name: "min" | "max" | "round"; args: Node[] };

export type ParseResult = { ok: true; ast: Node; refs: string[] } | { ok: false; error: string; pos: number };

export const MAX_FORMULA_LENGTH = 500;
const MAX_DEPTH = 40;

// ---------------------------------------------------------------- rationals

const babs = (x: bigint) => (x < BigInt(0) ? -x : x);
function gcd(a: bigint, b: bigint): bigint { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a || BigInt(1); }
export function rat(n: bigint, d: bigint = BigInt(1)): Rat {
  if (d === BigInt(0)) throw new FormulaError("Division by zero.");
  if (d < BigInt(0)) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
export const add = (a: Rat, b: Rat) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rat, b: Rat) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rat, b: Rat) => rat(a.n * b.n, a.d * b.d);
export const div = (a: Rat, b: Rat) => { if (b.n === BigInt(0)) throw new FormulaError("Division by zero."); return rat(a.n * b.d, a.d * b.n); };
export const cmp = (a: Rat, b: Rat) => { const l = a.n * b.d, r = b.n * a.d; return l < r ? -1 : l > r ? 1 : 0; };

/** Round half away from zero to an integer. */
export function roundHalfUp(x: Rat): bigint {
  const q = babs(x.n) / x.d, r = babs(x.n) % x.d;
  const up = r * BigInt(2) >= x.d ? q + BigInt(1) : q;
  return x.n < BigInt(0) ? -up : up;
}
/** Round to `digits` decimals (negative digits round to tens, hundreds, …), half away from zero. */
export function roundTo(x: Rat, digits: number): Rat {
  const p = BigInt(10) ** BigInt(Math.abs(digits));
  return digits >= 0 ? rat(roundHalfUp(mul(x, rat(p))), p) : rat(roundHalfUp(div(x, rat(p))) * p);
}

/** Exact decimal string ("12.5", "-0.12", "50.0000") → rational. Returns null for anything else (no floats, no exponents). */
export function parseDecimal(s: string): Rat | null {
  const m = /^(-?)(\d{1,15})(?:\.(\d{1,8}))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[3] ?? "";
  const v = rat(BigInt(m[2] + frac), BigInt(10) ** BigInt(frac.length));
  return m[1] ? rat(-v.n, v.d) : v;
}

export class FormulaError extends Error {}

// ---------------------------------------------------------------- tokenizer + parser

type Tok = { k: "num"; v: string; pos: number } | { k: "ref"; v: string; pos: number } | { k: "id"; v: string; pos: number } | { k: "op"; v: string; pos: number } | { k: "end"; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9.]+/.exec(src.slice(i))![0];
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(m)) throw new ParseErr(`"${m}" isn't a number.`, i);
      out.push({ k: "num", v: m.startsWith(".") ? "0" + m : m, pos: i }); i += m.length; continue;
    }
    if (c === "[") {
      const end = src.indexOf("]", i);
      if (end < 0) throw new ParseErr("A [ is missing its closing ].", i);
      const code = src.slice(i + 1, end).trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(code)) throw new ParseErr(`"[${src.slice(i + 1, end)}]" isn't a component code. Codes look like [BASIC].`, i);
      out.push({ k: "ref", v: code, pos: i }); i = end + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))![0];
      out.push({ k: "id", v: m.toLowerCase(), pos: i }); i += m.length; continue;
    }
    if ("+-*/(),".includes(c)) { out.push({ k: "op", v: c, pos: i }); i++; continue; }
    throw new ParseErr(`"${c}" can't be used in a formula.`, i);
  }
  out.push({ k: "end", pos: src.length });
  return out;
}

class ParseErr extends Error { constructor(message: string, public pos: number) { super(message); } }

export function parseFormula(src: string): ParseResult {
  if (!src.trim()) return { ok: false, error: "Enter a formula, like [BASIC] * 0.4.", pos: 0 };
  if (src.length > MAX_FORMULA_LENGTH) return { ok: false, error: `Keep formulas under ${MAX_FORMULA_LENGTH} characters.`, pos: MAX_FORMULA_LENGTH };
  try {
    const toks = tokenize(src);
    let p = 0;
    const refs = new Set<string>();
    const peek = () => toks[p];
    const isOp = (v: string) => { const t = peek(); return t.k === "op" && t.v === v; };
    const expect = (v: string) => { if (!isOp(v)) throw new ParseErr(`Expected "${v}" here.`, peek().pos); p++; };
    const expr = (depth: number): Node => {
      if (depth > MAX_DEPTH) throw new ParseErr("This formula is nested too deeply.", peek().pos);
      let a = term(depth);
      while (isOp("+") || isOp("-")) { const op = (toks[p++] as { v: "+" | "-" }).v; a = { t: "bin", op, a, b: term(depth) }; }
      return a;
    };
    const term = (depth: number): Node => {
      let a = unary(depth);
      while (isOp("*") || isOp("/")) { const op = (toks[p++] as { v: "*" | "/" }).v; a = { t: "bin", op, a, b: unary(depth) }; }
      return a;
    };
    const unary = (depth: number): Node => {
      if (isOp("-")) { p++; return { t: "neg", x: unary(depth + 1) }; }
      if (isOp("+")) { p++; return unary(depth + 1); }
      return primary(depth);
    };
    const primary = (depth: number): Node => {
      const t = peek();
      if (t.k === "num") { p++; const v = parseDecimal(t.v); if (!v) throw new ParseErr(`"${t.v}" is too long a number.`, t.pos); return { t: "num", v }; }
      if (t.k === "ref") { p++; refs.add(t.v); return { t: "ref", code: t.v }; }
      if (t.k === "id") {
        if (t.v !== "min" && t.v !== "max" && t.v !== "round") throw new ParseErr(`"${t.v}" isn't something formulas know. Use [CODE] for components, or min, max, round.`, t.pos);
        p++;
        expect("(");
        const args = [expr(depth + 1)];
        while (isOp(",")) { p++; args.push(expr(depth + 1)); }
        expect(")");
        if ((t.v === "min" || t.v === "max") && args.length < 2) throw new ParseErr(`${t.v}() needs at least two values.`, t.pos);
        if (t.v === "round") {
          if (args.length > 2) throw new ParseErr("round() takes a value and, optionally, the number of decimals.", t.pos);
          if (args[1] && !(args[1].t === "num" && args[1].v.d === BigInt(1) && args[1].v.n >= -BigInt(6) && args[1].v.n <= BigInt(2))
            && !(args[1].t === "neg" && args[1].x.t === "num" && args[1].x.v.d === BigInt(1) && args[1].x.v.n <= BigInt(6))) throw new ParseErr("round()'s decimals must be a whole number from -6 to 2.", t.pos);
        }
        return { t: "fn", name: t.v, args };
      }
      if (isOp("(")) { p++; const e = expr(depth + 1); expect(")"); return e; }
      if (t.k === "end") throw new ParseErr("The formula ends too early.", t.pos);
      throw new ParseErr(`"${(t as { v: string }).v}" is out of place here.`, t.pos);
    };
    const ast = expr(0);
    if (peek().k !== "end") throw new ParseErr(`"${(peek() as { v: string }).v}" is out of place here.`, peek().pos);
    return { ok: true, ast, refs: [...refs] };
  } catch (e) {
    if (e instanceof ParseErr) return { ok: false, error: e.message, pos: e.pos };
    throw e;
  }
}

/** Evaluate an AST. `get` supplies the value (in rupees) of each [CODE]. Throws FormulaError on division by zero. */
export function evaluate(ast: Node, get: (code: string) => Rat): Rat {
  switch (ast.t) {
    case "num": return ast.v;
    case "ref": return get(ast.code);
    case "neg": { const x = evaluate(ast.x, get); return rat(-x.n, x.d); }
    case "bin": {
      const a = evaluate(ast.a, get), b = evaluate(ast.b, get);
      return ast.op === "+" ? add(a, b) : ast.op === "-" ? sub(a, b) : ast.op === "*" ? mul(a, b) : div(a, b);
    }
    case "fn": {
      if (ast.name === "round") {
        const x = evaluate(ast.args[0], get);
        const digits = ast.args[1] ? Number(evaluate(ast.args[1], get).n) : 0;
        return roundTo(x, digits);
      }
      const vals = ast.args.map((a) => evaluate(a, get));
      return vals.reduce((m, v) => ((ast.name === "min" ? cmp(v, m) < 0 : cmp(v, m) > 0) ? v : m));
    }
  }
}
