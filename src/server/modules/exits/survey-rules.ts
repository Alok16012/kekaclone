/** Exit survey rules: question shapes, answer checks and result summaries. Pure (no I/O). */

export const EXIT_QUESTION_TYPES = ["text", "rating", "choice", "yes_no"] as const;
export type ExitQuestionType = (typeof EXIT_QUESTION_TYPES)[number];
export const EXIT_QUESTION_LABEL: Record<ExitQuestionType, string> = { text: "Free text", rating: "Rating 1–5", choice: "Pick one", yes_no: "Yes / no" };

export type ExitQuestion = { id: string; prompt: string; type: ExitQuestionType; options: string[]; required: boolean };
export type ExitAnswer = string | number | boolean | null;

export const DEFAULT_EXIT_QUESTIONS: { prompt: string; type: ExitQuestionType; options?: string[]; required?: boolean }[] = [
  { prompt: "What is the main reason you're leaving?", type: "choice", options: ["Better opportunity", "Compensation", "Career growth", "Manager or team", "Work-life balance", "Relocation or personal", "Other"] },
  { prompt: "How would you rate your overall experience here?", type: "rating" },
  { prompt: "Did you feel your work was recognised?", type: "rating" },
  { prompt: "Would you recommend this company as a place to work?", type: "yes_no" },
  { prompt: "Would you consider coming back in the future?", type: "yes_no" },
  { prompt: "What could we have done differently to keep you?", type: "text", required: false },
  { prompt: "Anything else you'd like to share?", type: "text", required: false },
];

export function validateExitQuestion(q: { prompt: unknown; type: unknown; options?: unknown; required?: unknown }): { ok: true; value: Omit<ExitQuestion, "id"> } | { ok: false; error: string; field: string } {
  const prompt = typeof q.prompt === "string" ? q.prompt.trim().slice(0, 300) : "";
  if (!prompt) return { ok: false, error: "Write the question.", field: "prompt" };
  if (!(EXIT_QUESTION_TYPES as readonly unknown[]).includes(q.type)) return { ok: false, error: "Pick a question type.", field: "type" };
  const type = q.type as ExitQuestionType;
  const options = type === "choice" ? (Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string").map((o) => o.trim().slice(0, 120)).filter(Boolean) : []) : [];
  if (type === "choice" && options.length < 2) return { ok: false, error: "Give at least two choices.", field: "options" };
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return { ok: false, error: "Choices must be different.", field: "options" };
  return { ok: true, value: { prompt, type, options, required: q.required !== false } };
}

/** Check one answer against its question; returns the cleaned value or a message. */
export function validateExitAnswer(q: ExitQuestion, v: ExitAnswer | undefined): { ok: true; value: ExitAnswer } | { ok: false; error: string } {
  const empty = v === undefined || v === null || v === "";
  if (empty) return q.required ? { ok: false, error: "This one needs an answer." } : { ok: true, value: null };
  switch (q.type) {
    case "text": return typeof v === "string" ? { ok: true, value: v.trim().slice(0, 2000) } : { ok: false, error: "Write an answer." };
    case "rating": return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? { ok: true, value: v } : { ok: false, error: "Pick 1 to 5." };
    case "choice": return typeof v === "string" && q.options.includes(v) ? { ok: true, value: v } : { ok: false, error: "Pick one of the choices." };
    case "yes_no": return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: "Pick yes or no." };
  }
}

export function validateExitAnswers(questions: ExitQuestion[], answers: Record<string, ExitAnswer>) {
  const clean: Record<string, ExitAnswer> = {};
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const r = validateExitAnswer(q, answers[q.id]);
    if (r.ok) { if (r.value !== null) clean[q.id] = r.value; } else errors[q.id] = r.error;
  }
  return { clean, errors, ok: Object.keys(errors).length === 0 };
}

export type ExitSummary =
  | { type: "rating"; count: number; average: number | null; distribution: number[] }
  | { type: "yes_no"; count: number; yes: number; no: number }
  | { type: "choice"; count: number; counts: { option: string; n: number }[] }
  | { type: "text"; count: number; answers: string[] };

export function summarizeExit(q: ExitQuestion, values: ExitAnswer[]): ExitSummary {
  const given = values.filter((v) => v !== null && v !== undefined && v !== "");
  switch (q.type) {
    case "rating": {
      const nums = given.filter((v): v is number => typeof v === "number");
      const distribution = [1, 2, 3, 4, 5].map((n) => nums.filter((x) => x === n).length);
      return { type: "rating", count: nums.length, average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null, distribution };
    }
    case "yes_no": { const yes = given.filter((v) => v === true).length; return { type: "yes_no", count: given.length, yes, no: given.length - yes }; }
    case "choice": return { type: "choice", count: given.length, counts: q.options.map((o) => ({ option: o, n: given.filter((v) => v === o).length })) };
    case "text": return { type: "text", count: given.length, answers: given.filter((v): v is string => typeof v === "string") };
  }
}
