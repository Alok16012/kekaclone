/**
 * Pure rules for the hiring and helpdesk assistants: the offline (rule-based) fallbacks, the privacy redaction applied
 * before anything leaves the app, and small decisions shared by the services and their tests.
 * Nothing here talks to the database or the network.
 */
import { addDaysISO, type ISODate } from "@/lib/dates";

// ---------------------------------------------------------------- text
const STOP = new Set((
  "a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its may me more most must my no not of on " +
  "or our ours out over own she should so some such than that the their them then there these they this those to too up us very was we were what when " +
  "where which while who whom why will with would you your yours about after again all also am any because before being below between both down during " +
  "each few further here how just like make many much only other same through under until via well within without per etc using use used able get " +
  // words every job description and resume share; they say nothing about the fit
  "experience experienced years year yrs work working worked role roles team teams job candidate candidates company responsibilities responsible " +
  "requirements required preferred strong good great excellent knowledge skills skill ability understanding including include includes plus new " +
  "looking join help ensure across key based level etc day days time end every least keep closely solid comfort clear everyone us tools"
).split(/\s+/));

export const stripHtml = (html: string) =>
  html.replace(/<(br|\/p|\/li|\/h[1-6]|\/div)\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

/** Lower-case word tokens (keeps things like c++, c#, node.js, next.js), without stop words. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]/g)) {
    const w = m[0].replace(/\.+$/, "");
    if (w.length < 2 && !/^[cr]$/.test(w)) continue;
    if (STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
/** Is this term (one or more words) in the text as a whole word? */
export function mentions(text: string, term: string) {
  return new RegExp(`(^|[^a-z0-9])${escapeRe(term.toLowerCase())}($|[^a-z0-9+#])`, "i").test(text.toLowerCase());
}

/**
 * Privacy: remove contact details and links before text goes to an outside AI service. The model needs the
 * experience and skills, not how to reach the person.
 */
export function redactContact(text: string): string {
  return text
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email removed]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(/\blinkedin\.com\/\S+/gi, "[link removed]")
    .replace(/(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4,5}\b/g, (m) => (m.replace(/\D/g, "").length >= 8 ? "[phone removed]" : m))
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[number removed]")        // Aadhaar-like
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[number removed]");          // PAN-like
}

export const clampScore = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0);

// ---------------------------------------------------------------- resume vs JD (keyword fallback)
/**
 * The terms a job description asks for: the listed skills first, then its most frequent meaningful words.
 * At most `limit` terms, in priority order.
 */
export function jdTerms(jdText: string, skills: string[] = [], limit = 24): string[] {
  const out: string[] = [];
  const add = (t: string) => { const k = t.trim().toLowerCase(); if (k && !out.includes(k) && !STOP.has(k)) out.push(k); };
  for (const s of skills) add(s);
  for (const t of namedTerms(jdText)) add(t);
  const freq = new Map<string, { n: number; first: number }>();
  words(jdText).forEach((w, i) => { const f = freq.get(w); if (f) f.n++; else freq.set(w, { n: 1, first: i }); });
  [...freq.entries()].filter(([w]) => w.length >= 3 || /[+#]/.test(w))
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).forEach(([w]) => add(w));
  return out.slice(0, limit);
}

/**
 * Names of tools and technologies in a text: words written with a capital (or in capitals) that don't start a
 * sentence or a line (Java, PostgreSQL, AWS, Node.js), plus words like c++ / c#. These say most about the fit.
 */
export function namedTerms(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n/)) {
    // a short line where every meaningful word is capitalised is a list of names ("• Java and Spring", "AWS, Docker")
    const ws = line.replace(/^[\s•*\-–\d.)]+/, "").match(/[A-Za-z0-9][A-Za-z0-9+#.]*/g) ?? [];
    const meaningful = ws.filter((w) => !STOP.has(w.toLowerCase()));
    const listLine = ws.length > 0 && ws.length <= 6 && meaningful.length > 0 && meaningful.every((w) => /^[A-Z0-9]/.test(w));
    const re = /[A-Za-z0-9][A-Za-z0-9+#.]*[A-Za-z0-9+#]|[A-Za-z]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const w = m[0].replace(/\.+$/, "");
      const before = line.slice(0, m.index).trimEnd();
      const starts = !before || /[.!?:;•*\-–(]$/.test(before);
      const named = (/^[A-Z]/.test(w) && (!starts || listLine)) || /^[A-Z0-9]{2,}$/.test(w) || /[a-z][A-Z]/.test(w) || /[+#]/.test(w);
      const k = w.toLowerCase();
      if (named && (k.length >= 2 || /^[cr]$/.test(k)) && !STOP.has(k) && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

export type MatchResult = { score: number; summary: string; strengths: string[]; gaps: string[]; matched: string[]; missing: string[] };

/**
 * Offline match score: how many of the job's terms the resume mentions (listed skills and named tools count three
 * times), minus a little
 * when the stated experience is under the minimum. Advisory only.
 */
export function keywordMatch(a: { jdText: string; skills?: string[]; resumeText: string; experienceMin?: number | null; experienceYears?: number | null }): MatchResult {
  const skills = (a.skills ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const terms = jdTerms(a.jdText, skills);
  if (!terms.length) return { score: 0, summary: "The job description is empty, so there is nothing to compare against.", strengths: [], gaps: [], matched: [], missing: [] };
  const named = new Set(namedTerms(a.jdText));
  const weight = (t: string) => (skills.includes(t) || named.has(t) ? 3 : 1);   // listed skills and named tools say most about the fit
  const matched = terms.filter((t) => mentions(a.resumeText, t));
  const missing = terms.filter((t) => !matched.includes(t));
  const total = terms.reduce((s, t) => s + weight(t), 0);
  let score = (100 * matched.reduce((s, t) => s + weight(t), 0)) / total;
  const gaps: string[] = [];
  if (a.experienceMin != null && a.experienceYears != null && a.experienceYears < a.experienceMin) {
    score -= Math.min(20, (a.experienceMin - a.experienceYears) * 5);
    gaps.push(`States ${a.experienceYears} years of experience; the job asks for ${a.experienceMin}+.`);
  }
  const strengths = matched.length ? [`Mentions ${listOf(matched.slice(0, 8))}.`] : [];
  if (missing.length) gaps.push(`No mention of ${listOf(missing.slice(0, 8))}.`);
  const s = clampScore(score);
  return {
    score: s, strengths, gaps, matched, missing,
    summary: `${matched.length} of ${terms.length} terms from the job description appear in the resume. Keyword overlap only; it can't judge context or quality.`,
  };
}

const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export const scoreBand = (s: number): { label: string; tone: "success" | "warning" | "neutral" } =>
  s >= 70 ? { label: "Strong match", tone: "success" } : s >= 40 ? { label: "Partial match", tone: "warning" } : { label: "Weak match", tone: "neutral" };

// ---------------------------------------------------------------- JD draft (offline outline)
export type JdBrief = {
  title: string; skills: string[]; experienceMin?: number | null; experienceMax?: number | null; jobType?: string | null;
  department?: string | null; location?: string | null; company: string; notes?: string | null;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const JOB_TYPE_WORDS: Record<string, string> = { full_time: "full-time", part_time: "part-time", contract: "contract", intern: "internship" };

export function experienceText(min?: number | null, max?: number | null) {
  if (min != null && max != null && max > min) return `${min} to ${max} years`;
  if (min != null && min > 0) return `${min}+ years`;
  if (max != null) return `up to ${max} years`;
  return null;
}

/** A plain, structured job-description outline built from the brief. Clearly a starting point for the recruiter to edit. */
export function outlineJd(b: JdBrief): string {
  const title = esc(b.title.trim() || "this role");
  const skills = b.skills.map((s) => s.trim()).filter(Boolean).slice(0, 12).map(esc);
  const exp = experienceText(b.experienceMin, b.experienceMax);
  const where = [b.department && `the ${esc(b.department)} team`, b.location && `based in ${esc(b.location)}`].filter(Boolean).join(", ");
  const kind = b.jobType ? JOB_TYPE_WORDS[b.jobType] ?? "" : "";
  const li = (xs: string[]) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;
  const parts = [
    `<h2>About the role</h2>`,
    `<p>${esc(b.company)} is hiring a ${kind ? `${kind} ` : ""}<strong>${title}</strong>${where ? ` in ${where}` : ""}. Describe in a sentence or two why this role matters and what success looks like in the first six months.</p>`,
    `<h2>What you'll do</h2>`,
    li([
      `Own the day-to-day work of a ${title}${skills.length ? `, using ${skills.slice(0, 3).join(", ")}` : ""}.`,
      "Plan and deliver work with your manager and the wider team, and keep people updated on progress.",
      "Spot problems early, suggest improvements and help the team get better at what it does.",
      ...(b.notes?.trim() ? [esc(b.notes.trim().slice(0, 300))] : []),
    ]),
    `<h2>What we're looking for</h2>`,
    li([
      ...(exp ? [`${exp} of relevant experience.`] : []),
      ...(skills.length ? skills.map((s) => `Hands-on experience with ${s}.`) : ["Add the skills this role needs."]),
      "Clear written and spoken communication.",
    ]),
    `<h2>Nice to have</h2>`,
    li(["Add anything that would help but isn't essential."]),
    `<h2>Why join us</h2>`,
    `<p>Tell candidates about the team, how you work and what you offer.</p>`,
  ];
  return parts.join("");
}

// ---------------------------------------------------------------- policy search (offline helpdesk answers)
export type DocText = { id: string; title: string; text: string };
export type Passage = { docId: string; title: string; text: string; score: number };

/** Split a document into passages of roughly `size` characters on paragraph / sentence boundaries. */
export function passages(text: string, size = 360): string[] {
  const paras = text.replace(/\r/g, "").split(/\n\s*\n|\n(?=[-•*]|\d+\.)/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of paras.flatMap((x) => (x.length > size * 1.5 ? x.match(new RegExp(`[^.!?]{1,${size}}[.!?]?`, "g")) ?? [x] : [x]))) {
    if ((cur + " " + p).length > size && cur) { out.push(cur.trim()); cur = p; } else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** BM25 over passages of the given documents; the best `limit` passages with at least one query term (one per document first). */
export function searchPolicies(question: string, docs: DocText[], limit = 3): Passage[] {
  const q = [...new Set(words(question))];
  if (!q.length) return [];
  const all = docs.flatMap((d) => passages(`${d.title}\n\n${d.text}`).map((text) => ({ docId: d.id, title: d.title, text, toks: words(text) })));
  if (!all.length) return [];
  const avg = all.reduce((s, p) => s + p.toks.length, 0) / all.length || 1;
  const df = new Map(q.map((t) => [t, all.filter((p) => p.toks.includes(t)).length]));
  const k1 = 1.2, b = 0.75, N = all.length;
  const scored = all.map((p) => {
    let s = 0;
    for (const t of q) {
      const f = p.toks.filter((x) => x === t).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * p.toks.length) / avg)));
    }
    return { docId: p.docId, title: p.title, text: p.text, score: s };
  }).filter((p) => p.score > 0).sort((x, y) => y.score - x.score);
  const out: Passage[] = [];
  for (const p of scored) if (!out.some((o) => o.docId === p.docId)) out.push(p);
  for (const p of scored) if (out.length < limit && !out.includes(p)) out.push(p);
  return out.slice(0, limit).map((p) => ({ ...p, score: Math.round(p.score * 100) / 100 }));
}

export type Citation = { n: number; docId: string; title: string; excerpt: string };
export type Suggestion = { answer: string; citations: Citation[]; confident: boolean };

/** Shorten to about `max` characters on a word boundary. */
export const excerpt = (s: string, max = 280) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…");

/** Offline answer: quote the best matching passages, each with its source. Says so plainly when nothing matches. */
export function searchSuggestion(question: string, docs: DocText[]): Suggestion {
  const hits = searchPolicies(question, docs, 3);
  if (!hits.length) return { answer: "", citations: [], confident: false };
  const citations = hits.map((h, i) => ({ n: i + 1, docId: h.docId, title: h.title, excerpt: excerpt(h.text) }));
  return { answer: citations.map((c) => `${c.excerpt} [${c.n}]`).join("\n\n"), citations, confident: hits[0].score >= 2 };
}

/** Keep only citation numbers that point at a source we actually gave the model. */
export const validCitationNumbers = (ns: unknown, sources: number) =>
  Array.isArray(ns) ? [...new Set(ns.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= sources))] : [];

// ---------------------------------------------------------------- candidate privacy
/** Candidates with no activity since this date are due for anonymising under a retention of `months`. */
export function retentionCutoff(today: ISODate, months: number): ISODate {
  const [y, m, d] = today.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12), nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export type ErasureCheck = { employeeId: string | null; anonymised: boolean; liveOffer: boolean; activeApplications: number };
/**
 * Can this candidate's data be erased now? Not when they became an employee (their record is now employment data),
 * and not while an offer is out or accepted (HR must withdraw it first). Already anonymised: nothing left to do.
 */
export function erasureBlocker(c: ErasureCheck): string | null {
  if (c.anonymised) return "This candidate's details were already removed.";
  if (c.employeeId) return "This person is now an employee, so their details are kept as employment records.";
  if (c.liveOffer) return "There's an offer out for this candidate. Withdraw it before removing their details.";
  return null;
}

export const RETENTION_OPTIONS = [6, 12, 18, 24, 36, 60] as const;
export const ERASED_NAME = "Removed candidate";
export const erasedEmail = (id: string) => `removed-${id}@erased.invalid`;

// ---------------------------------------------------------------- interview reminders
/** A scheduled interview starting within the next `hours` that hasn't had its reminder yet. */
export function reminderDue(i: { status: string; starts_at: Date | null; reminder_sent_at: Date | null }, now: Date, hours = 24) {
  if (i.status !== "scheduled" || !i.starts_at || i.reminder_sent_at) return false;
  const ms = i.starts_at.getTime() - now.getTime();
  return ms > 0 && ms <= hours * 3600_000;
}

/** Day offset helper used by the reminder copy ("today" / "tomorrow"). */
export function whenWords(startIst: ISODate, todayIst: ISODate) {
  return startIst === todayIst ? "today" : startIst === addDaysISO(todayIst, 1) ? "tomorrow" : "soon";
}
