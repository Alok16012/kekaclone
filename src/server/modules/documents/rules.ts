/** Documents and letters: folder access, upload limits, letter HTML (sanitise, placeholders, layout blocks). Pure (no I/O). */

// ---------- folder access ----------
export type FolderAccess = { type: "org" } | { type: "departments"; ids: string[] } | { type: "locations"; ids: string[] };

export function parseAccess(raw: unknown): FolderAccess {
  const r = (raw ?? {}) as { type?: string; ids?: unknown };
  const ids = Array.isArray(r.ids) ? r.ids.filter((x): x is string => typeof x === "string") : [];
  if ((r.type === "departments" || r.type === "locations") && ids.length) return { type: r.type, ids };
  return { type: "org" };
}

/** Can someone in this department/location see the folder? (HR with documents.manage sees everything; checked elsewhere.) */
export function canSeeFolder(access: FolderAccess, p: { department_id: string | null; location_id: string | null }) {
  if (access.type === "org") return true;
  const mine = access.type === "departments" ? p.department_id : p.location_id;
  return !!mine && access.ids.includes(mine);
}

// ---------- uploads ----------
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;   // 5 MB: fits the server-action body limit (6 MB in next.config); the files table allows 25 MB

const TYPES: Record<string, { mime: string; sig: "pdf" | "png" | "jpg" | "zip" | "text" }> = {
  pdf: { mime: "application/pdf", sig: "pdf" },
  png: { mime: "image/png", sig: "png" },
  jpg: { mime: "image/jpeg", sig: "jpg" },
  jpeg: { mime: "image/jpeg", sig: "jpg" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sig: "zip" },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sig: "zip" },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sig: "zip" },
  txt: { mime: "text/plain", sig: "text" },
};
export const ACCEPT = Object.keys(TYPES).map((e) => "." + e).join(",");
export const ACCEPT_LABEL = "PDF, Word, Excel, PowerPoint, PNG, JPG or text, up to 5 MB";

function signatureOk(sig: string, head: Uint8Array) {
  const starts = (...b: number[]) => b.every((x, i) => head[i] === x);
  switch (sig) {
    case "pdf": return starts(0x25, 0x50, 0x44, 0x46);              // %PDF
    case "png": return starts(0x89, 0x50, 0x4e, 0x47);
    case "jpg": return starts(0xff, 0xd8, 0xff);
    case "zip": return starts(0x50, 0x4b, 0x03, 0x04);
    case "text": return !head.slice(0, 512).includes(0);              // no NUL bytes
    default: return false;
  }
}

/**
 * The MIME type we store is decided by the extension and must match the file's first bytes,
 * so a renamed executable or HTML file can't be uploaded as a "PDF".
 */
export function validateUpload(f: { name: string; size: number; head: Uint8Array }): { ok: true; mime: string; name: string } | { ok: false; error: string } {
  const name = safeFileName(f.name);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const t = TYPES[ext];
  if (!t) return { ok: false, error: `This file type isn't allowed. Use ${ACCEPT_LABEL}.` };
  if (f.size <= 0) return { ok: false, error: "This file is empty." };
  if (f.size > MAX_UPLOAD_BYTES) return { ok: false, error: "This file is larger than 5 MB." };
  if (!signatureOk(t.sig, f.head)) return { ok: false, error: `This doesn't look like a real .${ext} file.` };
  return { ok: true, mime: t.mime, name };
}

/** File name safe for headers and disks: no paths, control characters or quotes; at most 120 characters. */
export function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").trim();
  if (!clean || clean === "." || clean === "..") return "file";
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 8 ? clean.slice(dot) : "";
  return clean.slice(0, 120 - ext.length) + ext;
}

// ---------- letter templates ----------
export const PLACEHOLDERS = [
  { key: "employee.name", label: "Full name", sample: "Ananya Sharma" },
  { key: "employee.first_name", label: "First name", sample: "Ananya" },
  { key: "employee.number", label: "Employee number", sample: "EMP-0042" },
  { key: "employee.email", label: "Work email", sample: "ananya@company.com" },
  { key: "employee.designation", label: "Designation", sample: "Product Designer" },
  { key: "employee.department", label: "Department", sample: "Design" },
  { key: "employee.location", label: "Location", sample: "Bengaluru" },
  { key: "employee.joining_date", label: "Joining date", sample: "3 April 2023" },
  { key: "employee.resignation_date", label: "Resignation date", sample: "1 October 2026" },
  { key: "employee.last_working_date", label: "Last working day", sample: "31 October 2026" },
  { key: "manager.name", label: "Manager's name", sample: "Vivek Rao" },
  { key: "company.name", label: "Company name", sample: "Your Company" },
  { key: "today", label: "Today's date", sample: "30 October 2026" },
] as const;
export type PlaceholderKey = (typeof PLACEHOLDERS)[number]["key"];
const KNOWN = new Set<string>(PLACEHOLDERS.map((p) => p.key));

const TOKEN = /\{\{\s*([a-z_.]+)\s*\}\}/g;

export function placeholdersIn(html: string): string[] {
  return [...new Set([...html.matchAll(TOKEN)].map((m) => m[1]))];
}
export const unknownPlaceholders = (html: string) => placeholdersIn(html).filter((k) => !KNOWN.has(k));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fill placeholders (values are HTML-escaped). Missing values stay visible as [Label] and are listed. */
export function mergeTemplate(html: string, values: Partial<Record<string, string | null | undefined>>): { html: string; missing: string[] } {
  const missing = new Set<string>();
  const out = html.replace(TOKEN, (_, k: string) => {
    const v = values[k];
    if (v == null || v === "") { missing.add(k); return `[${PLACEHOLDERS.find((p) => p.key === k)?.label ?? k}]`; }
    return esc(v);
  });
  return { html: out, missing: [...missing] };
}

const ALLOWED = new Set(["p", "br", "strong", "b", "em", "i", "u", "h2", "h3", "ul", "ol", "li", "div"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "head", "title"]);
const PART = /<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|<[!/?][^>]*>?|<|[^<]+/g;

/**
 * Letter HTML whitelist: a few block and inline tags, no attributes at all (so no styles, links, handlers or images).
 * Unknown tags are dropped but their text kept; script/style and friends are dropped with their content.
 */
export function sanitizeHtml(html: string): string {
  let out = "", skipping: string | null = null, depth = 0;
  for (const m of html.matchAll(PART)) {
    const tok = m[0], tag = m[1]?.toLowerCase();
    const closing = tok.startsWith("</");
    if (skipping) {
      if (tag === skipping) depth += closing ? -1 : tok.endsWith("/>") ? 0 : 1;
      if (depth <= 0) skipping = null;
      continue;
    }
    if (tag) {
      if (DROP_WITH_CONTENT.has(tag)) { if (!closing && !tok.endsWith("/>")) { skipping = tag; depth = 1; } continue; }
      if (!ALLOWED.has(tag)) continue;
      const t = tag === "b" ? "strong" : tag === "i" ? "em" : tag;
      out += tag === "br" ? "<br>" : closing ? `</${t}>` : `<${t}>`;
      continue;
    }
    if (tok === "<") { out += "&lt;"; continue; }   // a lone bracket is text
    if (tok.startsWith("<")) continue;              // comments, doctype, processing instructions
    out += tok.replace(/>/g, "&gt;");
  }
  return out.slice(0, 200_000);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•", copy: "©", reg: "®", trade: "™", rupee: "₹" };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

export type Run = { text: string; bold?: boolean; italic?: boolean; underline?: boolean };
export type Block = { kind: "h2" | "h3" | "p" | "li"; marker?: string; runs: Run[] };

/** Sanitised letter HTML → blocks of styled text runs, for the PDF renderer. Line breaks become "\n" runs. */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const lists: { ordered: boolean; n: number }[] = [];
  let cur: Block | null = null;
  const style = { bold: 0, italic: 0, underline: 0 };
  const flush = () => {
    if (cur && cur.runs.some((r) => r.text.trim())) {
      // trim the edges of the block
      while (cur.runs.length && !cur.runs[0].text.trim()) cur.runs.shift();
      while (cur.runs.length && !cur.runs[cur.runs.length - 1].text.trim()) cur.runs.pop();
      cur.runs[0].text = cur.runs[0].text.replace(/^\s+/, "");
      const last = cur.runs[cur.runs.length - 1]; last.text = last.text.replace(/\s+$/, "");
      blocks.push(cur);
    }
    cur = null;
  };
  const ensure = () => (cur ??= { kind: "p", runs: [] });
  for (const m of sanitizeHtml(html).matchAll(/<(\/?)([a-z0-9]+)>|[^<]+/g)) {
    if (!m[2]) {
      const text = decodeEntities(m[0]).replace(/[ \t\r\n]+/g, " ");
      if (!text) continue;
      if (!cur && !text.trim()) continue;
      ensure().runs.push({ text, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.underline ? { underline: true } : {}) });
      continue;
    }
    const closing = m[1] === "/", tag = m[2];
    switch (tag) {
      case "strong": style.bold += closing ? -1 : 1; break;
      case "em": style.italic += closing ? -1 : 1; break;
      case "u": style.underline += closing ? -1 : 1; break;
      case "br": ensure().runs.push({ text: "\n" }); break;
      case "ul": case "ol":
        flush();
        if (closing) lists.pop(); else lists.push({ ordered: tag === "ol", n: 0 });
        break;
      case "li":
        flush();
        if (!closing) {
          const l = lists[lists.length - 1];
          cur = { kind: "li", marker: l?.ordered ? `${++l.n}.` : "•", runs: [] };
        }
        break;
      case "h2": case "h3":
        flush();
        if (!closing) cur = { kind: tag, runs: [] };
        break;
      default:   // p, div
        flush();
    }
    style.bold = Math.max(0, style.bold); style.italic = Math.max(0, style.italic); style.underline = Math.max(0, style.underline);
  }
  flush();
  return blocks;
}

/** Long date as printed in letters, e.g. "3 April 2023". */
export function letterDate(iso: string | null | undefined) {
  if (!iso) return null;
  return new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export const LETTER_KINDS = [
  { value: "relieving", label: "Relieving letter" },
  { value: "experience", label: "Experience letter" },
  { value: "appointment", label: "Appointment letter" },
  { value: "confirmation", label: "Confirmation letter" },
  { value: "promotion", label: "Promotion letter" },
  { value: "transfer", label: "Transfer letter" },
  { value: "salary_revision", label: "Salary revision letter" },
  { value: "other", label: "Other" },
] as const;
export type LetterKind = (typeof LETTER_KINDS)[number]["value"];

export const DEFAULT_LETTERS: { name: string; kind: LetterKind; body: string }[] = [
  {
    name: "Relieving letter", kind: "relieving",
    body: `<p>{{today}}</p><p><strong>To whom it may concern</strong></p><h2>Relieving letter</h2>` +
      `<p>This is to confirm that <strong>{{employee.name}}</strong> (employee number {{employee.number}}) worked with {{company.name}} as {{employee.designation}} in the {{employee.department}} team from {{employee.joining_date}} to {{employee.last_working_date}}.</p>` +
      `<p>{{employee.first_name}} resigned on {{employee.resignation_date}} and has been relieved of all duties at the close of business on {{employee.last_working_date}}. All company property has been handed back.</p>` +
      `<p>We thank {{employee.first_name}} for their contributions and wish them the very best.</p><p>For {{company.name}}</p><p><strong>People team</strong></p>`,
  },
  {
    name: "Experience letter", kind: "experience",
    body: `<p>{{today}}</p><p><strong>To whom it may concern</strong></p><h2>Experience letter</h2>` +
      `<p>We certify that <strong>{{employee.name}}</strong> was employed with {{company.name}} from {{employee.joining_date}} to {{employee.last_working_date}}. During this time {{employee.first_name}} worked as {{employee.designation}} in the {{employee.department}} team, based in {{employee.location}}.</p>` +
      `<p>Throughout their time with us, {{employee.first_name}} was dependable and worked well with colleagues.</p><p>We wish {{employee.first_name}} success in the future.</p><p>For {{company.name}}</p><p><strong>People team</strong></p>`,
  },
];
