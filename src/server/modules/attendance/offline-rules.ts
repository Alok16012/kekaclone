/**
 * Offline clock-in queue: when the phone has no network the clock card keeps punches locally and sends them once
 * it's back. These are the server-side ordering rules (pure, unit-tested): punches are applied oldest first, each
 * must alternate with what the server already has, and anything in the future or older than the window is refused.
 */
export type QueuedPunch = { client_id: string; expect: "in" | "out"; at: string; lat?: number | null; lng?: number | null; accuracy?: number | null; comment?: string | null };
export type ServerState = { lastDirection: "in" | "out" | null; lastAt: string | null; now: Date };
export const OFFLINE_WINDOW_HOURS = 48;
export const MAX_QUEUE = 50;

export type Plan = { accept: QueuedPunch[]; reject: { client_id: string; reason: string }[] };

const isId = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(v);

/** Normalise untrusted input into QueuedPunch rows (bad rows are dropped with a reason). */
export function parseQueue(raw: unknown): { items: QueuedPunch[]; bad: { client_id: string; reason: string }[] } {
  const items: QueuedPunch[] = [], bad: { client_id: string; reason: string }[] = [];
  if (!Array.isArray(raw)) return { items, bad };
  for (const r of raw.slice(0, MAX_QUEUE) as Record<string, unknown>[]) {
    const id = isId(r?.client_id) ? (r.client_id as string) : null;
    if (!id) { bad.push({ client_id: String(r?.client_id ?? "?"), reason: "missing id" }); continue; }
    if (r.expect !== "in" && r.expect !== "out") { bad.push({ client_id: id, reason: "missing direction" }); continue; }
    const at = new Date(String(r.at ?? ""));
    if (Number.isNaN(at.getTime())) { bad.push({ client_id: id, reason: "bad time" }); continue; }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    items.push({ client_id: id, expect: r.expect, at: at.toISOString(), lat: num(r.lat), lng: num(r.lng), accuracy: num(r.accuracy), comment: typeof r.comment === "string" ? r.comment.slice(0, 500) : null });
  }
  return { items, bad };
}

/** Decide, in time order, which queued punches the server will record. */
export function planQueuedPunches(items: QueuedPunch[], s: ServerState): Plan {
  const plan: Plan = { accept: [], reject: [] };
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  let dir = s.lastDirection, lastAt = s.lastAt ? Date.parse(s.lastAt) : -Infinity;
  const lo = s.now.getTime() - OFFLINE_WINDOW_HOURS * 3600e3, hi = s.now.getTime() + 5 * 60e3;
  for (const p of sorted) {
    if (seen.has(p.client_id)) { plan.reject.push({ client_id: p.client_id, reason: "duplicate" }); continue; }
    seen.add(p.client_id);
    const t = Date.parse(p.at);
    if (t > hi) { plan.reject.push({ client_id: p.client_id, reason: "in the future" }); continue; }
    if (t < lo) { plan.reject.push({ client_id: p.client_id, reason: `older than ${OFFLINE_WINDOW_HOURS} hours` }); continue; }
    if (t <= lastAt) { plan.reject.push({ client_id: p.client_id, reason: "earlier than a punch already recorded" }); continue; }
    if ((p.expect === "in") === (dir === "in")) { plan.reject.push({ client_id: p.client_id, reason: dir === "in" ? "already clocked in at that time" : "not clocked in at that time" }); continue; }
    plan.accept.push(p);
    dir = p.expect; lastAt = t;
  }
  return plan;
}
