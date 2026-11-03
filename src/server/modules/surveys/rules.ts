/** Survey rules: question types and answers, schedule and pulse rounds, anonymity threshold, eNPS, CSV. Pure (no I/O). */
import { addDaysISO, fromISO, toISO, type ISODate } from "@/lib/dates";

export const QUESTION_TYPES = ["short_text", "long_text", "dropdown", "single", "multi", "yes_no", "nps", "opinion_scale", "rating", "date"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_LABEL: Record<QuestionType, string> = {
  short_text: "Short answer", long_text: "Paragraph", dropdown: "Dropdown", single: "Single choice", multi: "Multiple choice",
  yes_no: "Yes / no", nps: "Recommend score (0–10)", opinion_scale: "Opinion scale", rating: "Star rating", date: "Date",
};
export const CHOICE_TYPES: QuestionType[] = ["dropdown", "single", "multi"];
export const MIN_THRESHOLD = 3;

export type QuestionOptions = { choices?: string[]; max?: number; left?: string; right?: string };
export type QuestionInput = { type: QuestionType; prompt: string; required: boolean; options?: QuestionOptions | null };
export type Question = QuestionInput & { id: string };
export type Answer = string | number | string[] | null;

/** Validates a question and returns its cleaned options, or an error. */
export function validateQuestion(q: QuestionInput): { ok: true; options: QuestionOptions | null } | { ok: false; error: string; field: string } {
  if (!(QUESTION_TYPES as readonly string[]).includes(q.type)) return { ok: false, error: "Pick a question type.", field: "type" };
  const prompt = q.prompt.trim();
  if (!prompt) return { ok: false, error: "Write the question.", field: "prompt" };
  if (prompt.length > 500) return { ok: false, error: "Keep the question under 500 characters.", field: "prompt" };
  const o = q.options ?? {};
  if (CHOICE_TYPES.includes(q.type)) {
    const choices = [...new Set((o.choices ?? []).map((c) => c.trim().slice(0, 200)).filter(Boolean))];
    if (choices.length < 2) return { ok: false, error: "Add at least two different options.", field: "choices" };
    if (choices.length > 20) return { ok: false, error: "Use 20 options or fewer.", field: "choices" };
    return { ok: true, options: { choices } };
  }
  if (q.type === "opinion_scale") {
    const max = o.max ?? 5;
    if (![5, 7, 10].includes(max)) return { ok: false, error: "Use a scale of 5, 7 or 10.", field: "max" };
    return { ok: true, options: { max, left: o.left?.trim().slice(0, 60) || "Strongly disagree", right: o.right?.trim().slice(0, 60) || "Strongly agree" } };
  }
  if (q.type === "rating") {
    const max = o.max ?? 5;
    if (!Number.isInteger(max) || max < 3 || max > 10) return { ok: false, error: "Use between 3 and 10 stars.", field: "max" };
    return { ok: true, options: { max } };
  }
  return { ok: true, options: null };
}

const empty = (v: Answer | undefined) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** Checks one answer against its question. Returns the stored value (null for skipped), or an error. */
export function validateAnswer(q: Question, v: Answer | undefined): { ok: true; value: Answer } | { ok: false; error: string } {
  if (empty(v)) return q.required ? { ok: false, error: "This question needs an answer." } : { ok: true, value: null };
  const choices = q.options?.choices ?? [];
  switch (q.type) {
    case "short_text": case "long_text": {
      if (typeof v !== "string") return { ok: false, error: "Write an answer." };
      const t = v.trim(), max = q.type === "short_text" ? 300 : 3000;
      if (!t) return q.required ? { ok: false, error: "This question needs an answer." } : { ok: true, value: null };
      if (t.length > max) return { ok: false, error: `Keep it under ${max} characters.` };
      return { ok: true, value: t };
    }
    case "dropdown": case "single":
      return typeof v === "string" && choices.includes(v) ? { ok: true, value: v } : { ok: false, error: "Pick one of the options." };
    case "multi": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !choices.includes(x))) return { ok: false, error: "Pick from the options." };
      return { ok: true, value: choices.filter((c) => v.includes(c)) };   // option order, no duplicates
    }
    case "yes_no":
      return v === "yes" || v === "no" ? { ok: true, value: v } : { ok: false, error: "Answer yes or no." };
    case "nps": case "opinion_scale": case "rating": {
      const n = typeof v === "number" ? v : Number(v);
      const [min, max] = q.type === "nps" ? [0, 10] : [1, q.options?.max ?? 5];
      return Number.isInteger(n) && n >= min && n <= max ? { ok: true, value: n } : { ok: false, error: `Pick a number from ${min} to ${max}.` };
    }
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && toISO(fromISO(v)) === v ? { ok: true, value: v } : { ok: false, error: "Pick a date." };
  }
}

/** Every question answered the way it allows. Keys of the result are question ids; unknown ids are dropped. */
export function validateAnswers(questions: Question[], answers: Record<string, Answer>) {
  const out: Record<string, Answer> = {};
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const r = validateAnswer(q, answers[q.id]);
    if (r.ok) { if (r.value != null) out[q.id] = r.value; } else errors[q.id] = r.error;
  }
  return { answers: out, errors, ok: Object.keys(errors).length === 0 };
}

// ---------------------------------------------------------------- schedule + pulse rounds

export const RECURRENCES = ["none", "weekly", "monthly", "quarterly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];
export type Schedule = { startOn: ISODate | null; endOn: ISODate | null; recurrence: Recurrence; round: number; roundStartedOn: ISODate | null };
export const DEFAULT_SCHEDULE: Schedule = { startOn: null, endOn: null, recurrence: "none", round: 1, roundStartedOn: null };
export const schedule = (s: Partial<Schedule> | null | undefined): Schedule => ({ ...DEFAULT_SCHEDULE, ...(s ?? {}) });

export function validateSchedule(s: { startOn: ISODate | null; endOn: ISODate | null; recurrence: Recurrence }, today: ISODate): string | null {
  if (!(RECURRENCES as readonly string[]).includes(s.recurrence)) return "Pick how often it repeats.";
  if (s.startOn && s.startOn < today) return "The start date can't be in the past.";
  if (s.endOn && s.endOn < (s.startOn ?? today)) return "The end date must be after the start.";
  return null;
}

/** First day of the round after one that started on `from`. */
export function nextRoundStart(from: ISODate, r: Recurrence): ISODate | null {
  if (r === "none") return null;
  if (r === "weekly") return addDaysISO(from, 7);
  const d = fromISO(from), months = r === "monthly" ? 1 : 3;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));   // 31 Jan → 28/29 Feb
  return toISO(target);
}

export type SurveyStatus = "draft" | "live" | "closed";
/** What the scheduler should do to a survey today: launch a scheduled draft, start the next pulse round, or close it. */
export function dueTransition(status: SurveyStatus, s: Schedule, today: ISODate): "launch" | "next_round" | "close" | null {
  if (status === "draft") return s.startOn && s.startOn <= today ? (s.endOn && s.endOn < today ? null : "launch") : null;
  if (status !== "live") return null;
  if (s.endOn && s.endOn < today) return "close";
  const next = s.roundStartedOn ? nextRoundStart(s.roundStartedOn, s.recurrence) : null;
  return next && next <= today ? "next_round" : null;
}

/** Display status: a draft with a start date is "scheduled". */
export const displayStatus = (status: SurveyStatus, s: Schedule) => (status === "draft" && s.startOn ? "scheduled" : status);

// ---------------------------------------------------------------- results

/** Anonymous results only show when a group has at least `min` responses. Named surveys always show. */
export const canShow = (anonymous: boolean, count: number, min: number) => !anonymous || count >= Math.max(MIN_THRESHOLD, min);

/** eNPS = % promoters (9–10) − % detractors (0–6), rounded. */
export function enps(scores: number[]) {
  const n = scores.length;
  const promoters = scores.filter((s) => s >= 9).length, detractors = scores.filter((s) => s <= 6).length, passives = n - promoters - detractors;
  return { n, promoters, passives, detractors, score: n ? Math.round(((promoters - detractors) / n) * 100) : null };
}

export type QuestionSummary =
  | { kind: "choices"; total: number; counts: { label: string; count: number }[] }
  | { kind: "scale"; total: number; min: number; max: number; average: number | null; counts: { label: string; count: number }[]; enps?: ReturnType<typeof enps> }
  | { kind: "text"; total: number; answers: string[] }
  | { kind: "dates"; total: number; counts: { label: string; count: number }[] };

/** Summary of one question's answers (skipped answers are left out). Text answers are sorted so order can't identify anyone. */
export function summarize(q: Question, answers: Answer[]): QuestionSummary {
  const given = answers.filter((a) => !empty(a));
  switch (q.type) {
    case "dropdown": case "single": case "multi": case "yes_no": {
      const labels = q.type === "yes_no" ? ["yes", "no"] : q.options?.choices ?? [];
      const counts = labels.map((label) => ({ label: q.type === "yes_no" ? (label === "yes" ? "Yes" : "No") : label, count: given.filter((a) => (Array.isArray(a) ? a.includes(label) : a === label)).length }));
      return { kind: "choices", total: given.length, counts };
    }
    case "nps": case "opinion_scale": case "rating": {
      const [min, max] = q.type === "nps" ? [0, 10] : [1, q.options?.max ?? 5];
      const nums = given.map(Number).filter((n) => Number.isInteger(n) && n >= min && n <= max);
      const counts = Array.from({ length: max - min + 1 }, (_, i) => ({ label: String(min + i), count: nums.filter((n) => n === min + i).length }));
      const average = nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
      return { kind: "scale", total: nums.length, min, max, average, counts, ...(q.type === "nps" ? { enps: enps(nums) } : {}) };
    }
    case "date": {
      const m = new Map<string, number>();
      for (const a of given) if (typeof a === "string") m.set(a.slice(0, 7), (m.get(a.slice(0, 7)) ?? 0) + 1);
      return { kind: "dates", total: given.length, counts: [...m.entries()].sort().map(([label, count]) => ({ label, count })) };
    }
    default:
      return { kind: "text", total: given.length, answers: given.map(String).sort((a, b) => a.localeCompare(b)) };
  }
}

// ---------------------------------------------------------------- CSV

/** One CSV cell: quoted, and values a spreadsheet would run as a formula are made inert. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

// ---------------------------------------------------------------- starter templates

export const STARTERS: { key: string; title: string; description: string; anonymous: boolean; recurrence: Recurrence; questions: QuestionInput[] }[] = [
  { key: "blank", title: "Untitled survey", description: "", anonymous: false, recurrence: "none", questions: [] },
  {
    key: "enps", title: "Monthly pulse", description: "Two minutes, once a month. Answers are anonymous.", anonymous: true, recurrence: "monthly",
    questions: [
      { type: "nps", prompt: "How likely are you to recommend working here to a friend?", required: true },
      { type: "opinion_scale", prompt: "I have what I need to do my job well.", required: true, options: { max: 5 } },
      { type: "opinion_scale", prompt: "My manager gives me useful feedback.", required: true, options: { max: 5 } },
      { type: "long_text", prompt: "What's one thing we could do better?", required: false },
    ],
  },
  {
    key: "joiner", title: "First month check-in", description: "For people who joined recently.", anonymous: false, recurrence: "none",
    questions: [
      { type: "rating", prompt: "How was your first week overall?", required: true, options: { max: 5 } },
      { type: "yes_no", prompt: "Did you have everything you needed on day one?", required: true },
      { type: "multi", prompt: "What helped you most?", required: false, options: { choices: ["My buddy", "My manager", "The handbook", "Team introductions", "Training sessions"] } },
      { type: "short_text", prompt: "Anything still missing?", required: false },
    ],
  },
  {
    key: "event", title: "Team offsite planning", description: "Help us plan the next get-together.", anonymous: false, recurrence: "none",
    questions: [
      { type: "dropdown", prompt: "Which month suits you best?", required: true, options: { choices: ["January", "February", "March"] } },
      { type: "single", prompt: "What kind of activity would you enjoy?", required: true, options: { choices: ["Outdoor", "Workshop", "Dinner", "Volunteering"] } },
      { type: "date", prompt: "Any date you can't make?", required: false },
    ],
  },
];
