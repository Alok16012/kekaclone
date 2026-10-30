/** Asset rules: conditions and statuses, what a return does to an asset, recovery amounts (integer paise), request states. Pure (no I/O). */

export type Condition = "new" | "good" | "fair" | "damaged" | "lost";
export type AssetStatus = "available" | "assigned" | "in_repair" | "retired";
export type RequestStatus = "pending" | "approved" | "rejected" | "fulfilled" | "cancelled";

export const CONDITIONS: Condition[] = ["new", "good", "fair", "damaged", "lost"];
export const CONDITION_LABEL: Record<Condition, string> = { new: "New", good: "Good", fair: "Fair", damaged: "Damaged", lost: "Lost" };
export const STATUS_LABEL: Record<AssetStatus, string> = { available: "Available", assigned: "Assigned", in_repair: "In repair", retired: "Retired" };
export const REQUEST_LABEL: Record<RequestStatus, string> = { pending: "Waiting for approval", approved: "Approved, to be handed over", rejected: "Declined", fulfilled: "Handed over", cancelled: "Cancelled" };

/** Starter inventory structure for a new company. */
export const DEFAULT_ASSET_CATEGORIES: { name: string; types: { name: string; requiresAck: boolean; requestable: boolean }[] }[] = [
  { name: "Computers", types: [{ name: "Laptop", requiresAck: true, requestable: true }, { name: "Monitor", requiresAck: true, requestable: true }] },
  { name: "Accessories", types: [{ name: "Headset", requiresAck: false, requestable: true }, { name: "Keyboard and mouse", requiresAck: false, requestable: true }] },
  { name: "Access", types: [{ name: "ID card", requiresAck: true, requestable: false }] },
];

/** Status an asset can be set to by hand from the inventory. "Assigned" only comes from handing it over. */
export const MANUAL_STATUSES: AssetStatus[] = ["available", "in_repair", "retired"];

/** Only available assets in a usable condition can be handed over. */
export function canAssign(a: { status: AssetStatus; condition: Condition }): { ok: true } | { ok: false; reason: string } {
  if (a.status === "assigned") return { ok: false, reason: "is already with someone" };
  if (a.status === "in_repair") return { ok: false, reason: "is in repair" };
  if (a.status === "retired") return { ok: false, reason: "is retired" };
  if (a.condition === "lost") return { ok: false, reason: "is marked lost" };
  if (a.condition === "damaged") return { ok: false, reason: "is damaged" };
  return { ok: true };
}

/** What a return does to the asset: lost → retired, damaged → in repair, otherwise back on the shelf. */
export function afterReturn(condition: Condition): { status: AssetStatus; condition: Condition } {
  if (condition === "lost") return { status: "retired", condition };
  if (condition === "damaged") return { status: "in_repair", condition };
  return { status: "available", condition };
}

/**
 * Rupees typed by a person → integer paise, without floating point: "1,23,456.5" → 12345650 paise.
 * Returns null for blanks, negatives, more than two decimals or anything that isn't a number.
 */
export function rupeesToPaise(input: string): bigint | null {
  const s = input.replace(/[,\s₹]/g, "");
  const m = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * BigInt(100) + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

/** Integer paise → "1,23,456.50" (Indian grouping), exact for any bigint. */
export function formatPaise(p: bigint | number): string {
  const v = BigInt(p);
  const neg = v < BigInt(0);
  const abs = neg ? -v : v;
  const rupees = (abs / BigInt(100)).toString();
  const paise = (abs % BigInt(100)).toString().padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3 : last3;
  return `${neg ? "-" : ""}${grouped}.${paise}`;
}

/**
 * Checks a damage / loss recovery amount. Recovery is only for damaged or lost returns, never negative, and never more
 * than what the asset cost (when the cost is on record). Lost assets with a known cost default to the full cost.
 */
export function checkRecovery(condition: Condition, recoveryPaise: bigint, costPaise: bigint | null): { ok: true; paise: bigint } | { ok: false; error: string } {
  if (recoveryPaise < BigInt(0)) return { ok: false, error: "The recovery amount can't be negative." };
  if (recoveryPaise > BigInt(0) && condition !== "damaged" && condition !== "lost") return { ok: false, error: "Recovery only applies to damaged or lost assets." };
  if (costPaise != null && recoveryPaise > costPaise) return { ok: false, error: `The recovery can't be more than the asset's cost (₹${formatPaise(costPaise)}).` };
  return { ok: true, paise: recoveryPaise };
}

/** Suggested recovery shown when HR records a return: the full cost for a lost asset, nothing otherwise. */
export function suggestedRecovery(condition: Condition, costPaise: bigint | null): bigint {
  return condition === "lost" && costPaise != null ? costPaise : BigInt(0);
}

/** Sum of recovery amounts (for the final settlement). Exact integer arithmetic. */
export function totalRecovery(rows: { recovery_paise: bigint | number | string }[]): bigint {
  return rows.reduce((s, r) => s + BigInt(r.recovery_paise), BigInt(0));
}

/** An asset tag: letters, digits, dashes, slashes; 2–40 characters; stored upper-case. */
export function normaliseTag(tag: string): string | null {
  const t = tag.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9/_-]{1,39}$/.test(t) ? t : null;
}
