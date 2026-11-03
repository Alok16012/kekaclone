/** Pure rules for courses, quizzes, assignment rules and learner progress. */
import { addDaysISO, type ISODate } from "@/lib/dates";

export const MODULE_KINDS = ["video", "document", "text", "quiz", "link"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];
export const MODULE_KIND_LABEL: Record<ModuleKind, string> = { video: "Video", document: "Document", text: "Reading", quiz: "Quiz", link: "Web link" };

export type Question = { id: string; text: string; options: string[]; correct: number };
export type QuizContent = { questions: Question[]; pass_pct: number };
export type ModuleContent =
  | { kind: "video"; url: string | null }          // url or an uploaded file (file_id on the row)
  | { kind: "document"; note: string | null }      // uploaded file (file_id on the row)
  | { kind: "text"; html: string }
  | { kind: "link"; url: string }
  | ({ kind: "quiz" } & QuizContent);

export type Problem = { field: string; message: string };

const URL_OK = (u: string) => /^https?:\/\/[^\s]+$/i.test(u) && u.length <= 2000;
/** Video URLs we accept: direct media files or YouTube / Vimeo pages (embedded by the player). */
export const VIDEO_OK = (u: string) => URL_OK(u) && /(youtube\.com|youtu\.be|vimeo\.com|\.(mp4|webm|m4v)(\?|$))/i.test(u);

export function validateModule(input: { title: string; kind: string; content: unknown; hasFile: boolean }): Problem[] {
  const out: Problem[] = [];
  if (!input.title.trim()) out.push({ field: "title", message: "Give the module a title." });
  if (input.title.length > 160) out.push({ field: "title", message: "Keep the title under 160 characters." });
  if (!(MODULE_KINDS as readonly string[]).includes(input.kind)) { out.push({ field: "kind", message: "Pick a module type." }); return out; }
  const c = (input.content ?? {}) as Record<string, unknown>;
  if (input.kind === "video") {
    const url = typeof c.url === "string" ? c.url.trim() : "";
    if (!url && !input.hasFile) out.push({ field: "url", message: "Paste a video link (YouTube, Vimeo or an .mp4) or upload a file." });
    if (url && !VIDEO_OK(url)) out.push({ field: "url", message: "Use a YouTube, Vimeo or direct .mp4 link." });
  }
  if (input.kind === "document" && !input.hasFile) out.push({ field: "file", message: "Upload the document." });
  if (input.kind === "link") {
    const url = typeof c.url === "string" ? c.url.trim() : "";
    if (!URL_OK(url)) out.push({ field: "url", message: "Enter a full web address starting with https://." });
  }
  if (input.kind === "text") {
    const html = typeof c.html === "string" ? c.html : "";
    if (!html.replace(/<[^>]+>/g, "").trim()) out.push({ field: "html", message: "Write something for people to read." });
    if (html.length > 50000) out.push({ field: "html", message: "This reading is too long; split it into modules." });
  }
  if (input.kind === "quiz") {
    const q = Array.isArray(c.questions) ? (c.questions as Question[]) : [];
    if (!q.length) out.push({ field: "questions", message: "Add at least one question." });
    if (q.length > 50) out.push({ field: "questions", message: "At most 50 questions per quiz." });
    q.forEach((x, i) => {
      if (!x || typeof x.text !== "string" || !x.text.trim()) out.push({ field: `questions.${i}.text`, message: `Question ${i + 1} needs text.` });
      const opts = Array.isArray(x?.options) ? x.options.filter((o) => typeof o === "string" && o.trim()) : [];
      if (opts.length < 2) out.push({ field: `questions.${i}.options`, message: `Question ${i + 1} needs at least two options.` });
      if (opts.length > 8) out.push({ field: `questions.${i}.options`, message: `Question ${i + 1} has too many options (8 max).` });
      if (!Number.isInteger(x?.correct) || x.correct < 0 || x.correct >= opts.length) out.push({ field: `questions.${i}.correct`, message: `Mark the right answer for question ${i + 1}.` });
    });
    const pass = Number(c.pass_pct);
    if (!Number.isInteger(pass) || pass < 1 || pass > 100) out.push({ field: "pass_pct", message: "Pass mark is 1–100%." });
  }
  return out;
}

/** Normalise module content for storage: trims, drops unknown keys. */
export function cleanContent(kind: ModuleKind, raw: unknown): ModuleContent {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === "string" ? (c[k] as string).trim() : "");
  switch (kind) {
    case "video": return { kind, url: str("url") || null };
    case "document": return { kind, note: str("note").slice(0, 500) || null };
    case "text": return { kind, html: str("html") };
    case "link": return { kind, url: str("url") };
    case "quiz": {
      const questions = (Array.isArray(c.questions) ? (c.questions as Question[]) : []).map((q, i) => ({
        id: typeof q.id === "string" && q.id ? q.id.slice(0, 40) : `q${i + 1}`,
        text: String(q.text ?? "").trim().slice(0, 500),
        options: (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o === "string" && o.trim()).map((o) => o.trim().slice(0, 200)),
        correct: Number(q.correct),
      }));
      return { kind, questions, pass_pct: Number(c.pass_pct) || 70 };
    }
  }
}

/** What a learner is allowed to see of a quiz: the questions, never the answer key. */
export function learnerQuiz(q: QuizContent) {
  return { questions: q.questions.map(({ id, text, options }) => ({ id, text, options })), pass_pct: q.pass_pct };
}

export function scoreQuiz(q: QuizContent, answers: unknown): { score: number; total: number; pct: number; passed: boolean; answers: (number | null)[] } {
  const a = Array.isArray(answers) ? answers : [];
  const picked = q.questions.map((_, i) => (Number.isInteger(a[i]) ? Number(a[i]) : null));
  const score = q.questions.reduce((s, x, i) => s + (picked[i] === x.correct ? 1 : 0), 0);
  const total = q.questions.length;
  const pct = total ? Math.round((score / total) * 100) : 0;
  return { score, total, pct, passed: total > 0 && pct >= q.pass_pct, answers: picked };
}

// ---------- progress ----------
export type Progress = { modules?: Record<string, { done_at: string }> };
export function percentDone(moduleIds: string[], progress: Progress) {
  if (!moduleIds.length) return 0;
  const done = moduleIds.filter((id) => progress.modules?.[id]).length;
  return Math.round((done / moduleIds.length) * 10000) / 100;
}
export const isComplete = (moduleIds: string[], progress: Progress) => moduleIds.length > 0 && moduleIds.every((id) => progress.modules?.[id]);
export const nextModule = (moduleIds: string[], progress: Progress) => moduleIds.find((id) => !progress.modules?.[id]) ?? null;

export type EnrollmentState = "not_started" | "in_progress" | "completed" | "overdue";
export function enrollmentState(e: { percent: number; completed_at: string | Date | null; due_date: string | null }, today: ISODate): EnrollmentState {
  if (e.completed_at) return "completed";
  if (e.due_date && e.due_date < today) return "overdue";
  return Number(e.percent) > 0 ? "in_progress" : "not_started";
}
export const STATE_LABEL: Record<EnrollmentState, string> = { not_started: "Not started", in_progress: "In progress", completed: "Completed", overdue: "Overdue" };

// ---------- assignment rules ----------
export type Rule =
  | { kind: "everyone" }
  | { kind: "people"; ids: string[] }
  | { kind: "departments"; ids: string[] }
  | { kind: "locations"; ids: string[] }
  | { kind: "designations"; ids: string[] }
  | { kind: "new_joiners"; within_days: number };
export const RULE_KINDS = ["everyone", "people", "departments", "locations", "designations", "new_joiners"] as const;
export const RULE_LABEL: Record<Rule["kind"], string> = { everyone: "Everyone", people: "Specific people", departments: "Departments", locations: "Locations", designations: "Designations", new_joiners: "New joiners" };

export function parseRule(raw: unknown): Rule | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(r.ids) ? [...new Set(r.ids.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))] : [];
  switch (r.kind) {
    case "everyone": return { kind: "everyone" };
    case "people": case "departments": case "locations": case "designations": return ids.length ? { kind: r.kind, ids } : null;
    case "new_joiners": { const d = Number(r.within_days); return Number.isInteger(d) && d >= 1 && d <= 365 ? { kind: "new_joiners", within_days: d } : null; }
    default: return null;
  }
}

export type Placed = { id: string; department_id: string | null; location_id: string | null; designation_id: string | null; joining_date: ISODate };
export function ruleMatches(rule: Rule, p: Placed, today: ISODate) {
  switch (rule.kind) {
    case "everyone": return true;
    case "people": return rule.ids.includes(p.id);
    case "departments": return !!p.department_id && rule.ids.includes(p.department_id);
    case "locations": return !!p.location_id && rule.ids.includes(p.location_id);
    case "designations": return !!p.designation_id && rule.ids.includes(p.designation_id);
    case "new_joiners": return p.joining_date <= today && addDaysISO(p.joining_date, rule.within_days) >= today;
  }
}

export function describeRule(rule: Rule, names: (ids: string[]) => string[]) {
  if (rule.kind === "everyone") return "Everyone";
  if (rule.kind === "new_joiners") return `People who joined in the last ${rule.within_days} days`;
  const n = names(rule.ids);
  return `${RULE_LABEL[rule.kind]}: ${n.length ? n.join(", ") : `${rule.ids.length} selected`}`;
}

export const dueDateFor = (enrolledOn: ISODate, dueInDays: number | null) => (dueInDays == null ? null : addDaysISO(enrolledOn, dueInDays));

/** Should this person get a reminder today? Once a day, from `daysBefore` days ahead of the due date until it's done. */
export function reminderDue(e: { due_date: string | null; completed_at: unknown; reminded_on: string | null }, daysBefore: number | null, today: ISODate) {
  if (e.completed_at || !e.due_date || daysBefore == null) return false;
  if (e.reminded_on === today) return false;
  return addDaysISO(e.due_date, -daysBefore) <= today;
}

export function validateCourse(c: { title: string; description: string | null; estimatedMinutes: number | null }): Problem[] {
  const out: Problem[] = [];
  if (!c.title.trim()) out.push({ field: "title", message: "Give the course a title." });
  if (c.title.length > 160) out.push({ field: "title", message: "Keep the title under 160 characters." });
  if (c.description && c.description.length > 4000) out.push({ field: "description", message: "Keep the description under 4000 characters." });
  if (c.estimatedMinutes != null && (!Number.isInteger(c.estimatedMinutes) || c.estimatedMinutes < 0 || c.estimatedMinutes > 100000)) out.push({ field: "estimatedMinutes", message: "Duration is a number of minutes." });
  return out;
}

/** Allowed HTML for readings: a conservative subset, attributes dropped except href on links. */
export function sanitizeReading(html: string) {
  const allowed = new Set(["p", "br", "strong", "b", "em", "i", "u", "h2", "h3", "ul", "ol", "li", "a", "blockquote", "code", "pre"]);
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (m, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (!allowed.has(t)) return "";
    if (m.startsWith("</")) return `</${t}>`;
    if (t === "a") { const h = /href="(https?:\/\/[^"]+)"/i.exec(attrs); return h ? `<a href="${h[1]}" rel="noopener noreferrer" target="_blank">` : "<a>"; }
    return `<${t}>`;
  });
}

/** YouTube / Vimeo page links → embeddable player URLs; direct files pass through. */
export function embedUrl(url: string): { kind: "iframe" | "file"; src: string } {
  let m = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/i.exec(url);
  if (m) return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${m[1]}` };
  m = /vimeo\.com\/(\d+)/i.exec(url);
  if (m) return { kind: "iframe", src: `https://player.vimeo.com/video/${m[1]}` };
  return { kind: "file", src: url };
}
