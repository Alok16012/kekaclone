/**
 * Self-hosted sign-in challenge: after a few failed attempts the form asks a small arithmetic question that the
 * server generated and checks. No images, no third-party service, works with a screen reader. Pure (no I/O).
 */
export const CAPTCHA_AFTER_FAILURES = 3;
export const CAPTCHA_WINDOW_MINUTES = 15;
export const CAPTCHA_TTL_MINUTES = 10;

export type Challenge = { question: string; answer: number };

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A question like "What is seven plus 4?" with a small whole-number answer. `rnd` returns [0, 1). */
export function makeChallenge(rnd: () => number = Math.random): Challenge {
  const pick = (n: number) => Math.floor(rnd() * n);
  const a = 2 + pick(11), b = 1 + pick(9);
  const op = pick(3);
  const word = (n: number) => (pick(2) ? WORDS[n] ?? String(n) : String(n));
  if (op === 0) return { question: `What is ${word(a)} plus ${word(b)}?`, answer: a + b };
  if (op === 1) { const [x, y] = a >= b ? [a, b] : [b, a]; return { question: `What is ${word(x)} minus ${word(y)}?`, answer: x - y }; }
  const m = 2 + pick(4);
  return { question: `What is ${word(b)} times ${word(m)}?`, answer: b * m };
}

/** The typed answer, in digits or words, against the expected number. */
export function answerMatches(given: unknown, expected: number) {
  if (typeof given !== "string") return false;
  const s = given.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!s) return false;
  if (/^-?\d+$/.test(s)) return Number(s) === expected;
  const i = WORDS.indexOf(s);
  return i >= 0 && i === expected;
}

/** Whether the next attempt for this email must answer a challenge first. */
export const challengeRequired = (recentFailures: number) => recentFailures >= CAPTCHA_AFTER_FAILURES;
