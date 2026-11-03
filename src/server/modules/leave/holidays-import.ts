import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertLeaveAdmin } from "./access";

/**
 * Holiday lists from Excel: one row per holiday, with the list it belongs to. Lists that don't exist yet are created
 * (name + year), existing lists gain the new rows, and a holiday already on the list (same date and name) is skipped,
 * so the same file can be uploaded twice. Nothing is saved unless every row is valid.
 */

const HEADERS = ["Holiday list", "Year", "Date", "Name", "Optional", "Description"] as const;
const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 2000;

export async function buildHolidayTemplate(tx: Tx, actor: Actor, year: number) {
  assertLeaveAdmin(actor);
  const rows = await tx<{ list: string; year: number; date: string; name: string; floater: boolean; description: string | null }[]>`
    select hl.name as list, hl.year, h.date::text, h.name, h.is_floater as floater, h.description
    from holidays h join holiday_lists hl on hl.id = h.holiday_list_id where hl.year = ${year} order by hl.name, h.date`;
  const locations = await tx<{ name: string; list: string | null }[]>`select l.name, hl.name as list from locations l left join holiday_lists hl on hl.id = l.default_holiday_list_id order by l.name`;
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Holidays", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [{ header: "Holiday list *", width: 22 }, { header: "Year *", width: 8 }, { header: "Date *", width: 14 }, { header: "Name *", width: 30 }, { header: "Optional", width: 10 }, { header: "Description", width: 40 }];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  if (rows.length) for (const r of rows) ws.addRow([r.list, r.year, r.date, r.name, r.floater ? "yes" : "no", r.description ?? ""]);
  else ws.addRow(["Head office", year, `${year}-01-26`, "Republic Day", "no", ""]);
  ws.getColumn(3).numFmt = "@";
  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "One row per holiday. Holiday list = the list's name (one list per location, e.g. Head office, Pune plant). A list that doesn't exist yet is created for that year.",
    "Date as YYYY-MM-DD (or an Excel date). It must fall in the Year column's year.",
    "Optional = yes for floater holidays people may pick (the list's limit decides how many), no or blank otherwise.",
    "A holiday that is already on the list with the same date and name is skipped, so you can upload the same file again safely.",
    "After importing, open Settings → Holidays to assign each list to its locations.",
    locations.length ? "Your locations: " + locations.map((l) => `${l.name}${l.list ? ` (uses ${l.list})` : " (no list yet)"}`).join(", ") + "." : "",
  ].filter(Boolean).forEach((s, i) => (help.getCell(i + 1, 1).value = s));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type HolidayImportRow = { rowNumber: number; list: string; year: number | null; date: string | null; name: string; optional: boolean; description: string | null; newList: boolean; exists: boolean; errors: string[] };
export type HolidayImportPreview = { valid: boolean; total: number; toAdd: number; skipped: number; newLists: string[]; results: HolidayImportRow[] };

const toDate = (v: unknown): string | null => {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);   // dd/mm/yyyy
  if (m) { const d = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; return new Date(d + "T00:00:00Z").toISOString().startsWith(d) ? d : null; }
  return null;
};
const yesNo = (v: unknown): boolean | null => {
  const s = String(v ?? "").trim().toLowerCase();
  if (["", "no", "n", "false", "0"].includes(s)) return false;
  if (["yes", "y", "true", "1", "optional", "floater"].includes(s)) return true;
  return null;
};

async function check(tx: Tx, actor: Actor, bytes: ArrayBuffer): Promise<HolidayImportPreview> {
  assertLeaveAdmin(actor);
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Holidays") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String((s as { text?: string })?.text ?? s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => { const h = HEADERS.find((x) => x.toLowerCase() === norm(c.value)); if (h) col.set(h, i); });
  const missing = HEADERS.filter((h) => h !== "Optional" && h !== "Description" && !col.has(h));
  if (missing.length) throw new AppError("invalid", `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the erp template.`);
  const raw: { rowNumber: number; list: string; year: unknown; date: unknown; name: string; optional: unknown; description: string }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (h: string) => { const i = col.get(h); if (!i) return null; const v = r.getCell(i).value; return (v as { result?: unknown })?.result ?? (v as { text?: string })?.text ?? v; };
    raw.push({ rowNumber: n, list: String(cell("Holiday list") ?? "").trim(), year: cell("Year"), date: cell("Date"), name: String(cell("Name") ?? "").trim(), optional: cell("Optional"), description: String(cell("Description") ?? "").trim() });
  });
  if (!raw.length) throw new AppError("invalid", "The file has no rows to import.");
  if (raw.length > MAX_ROWS) throw new AppError("invalid", `Up to ${MAX_ROWS} rows per file.`);
  const lists = await tx<{ id: string; name: string; year: number }[]>`select id, name, year from holiday_lists`;
  const existing = new Set((await tx<{ k: string }[]>`select hl.name || '|' || hl.year || '|' || h.date::text || '|' || lower(h.name) as k from holidays h join holiday_lists hl on hl.id = h.holiday_list_id`).map((r) => r.k));
  const seen = new Set<string>();
  const results: HolidayImportRow[] = raw.map((r) => {
    const errors: string[] = [];
    const year = typeof r.year === "number" ? r.year : Number(String(r.year ?? "").trim());
    const okYear = Number.isInteger(year) && year >= 2000 && year <= 2100;
    const date = toDate(r.date);
    const optional = yesNo(r.optional);
    if (!r.list) errors.push("Holiday list is empty.");
    else if (r.list.length > 80) errors.push("The list name is longer than 80 characters.");
    if (!okYear) errors.push("Year must be a four-digit year, like 2026.");
    if (!date) errors.push("Date must be a date, like 2026-01-26.");
    else if (okYear && Number(date.slice(0, 4)) !== year) errors.push(`${date} isn't in ${year}.`);
    if (!r.name) errors.push("Name is empty.");
    else if (r.name.length > 80) errors.push("The name is longer than 80 characters.");
    if (optional == null) errors.push("Optional must be yes or no.");
    if (r.description.length > 300) errors.push("The description is longer than 300 characters.");
    const k = `${r.list.toLowerCase()}|${year}|${date}|${r.name.toLowerCase()}`;
    if (!errors.length && seen.has(k)) errors.push("This holiday appears on an earlier row too.");
    seen.add(k);
    const list = lists.find((l) => l.name.toLowerCase() === r.list.toLowerCase() && l.year === year);
    return { rowNumber: r.rowNumber, list: list?.name ?? r.list, year: okYear ? year : null, date, name: r.name, optional: !!optional, description: r.description || null,
      newList: !list && okYear && !!r.list, exists: !!list && existing.has(`${list.name}|${year}|${date}|${r.name.toLowerCase()}`), errors };
  });
  const valid = results.every((r) => !r.errors.length);
  const newLists = [...new Set(results.filter((r) => r.newList && !r.errors.length).map((r) => `${r.list} (${r.year})`))];
  return { valid, total: results.length, toAdd: results.filter((r) => !r.errors.length && !r.exists).length, skipped: results.filter((r) => !r.errors.length && r.exists).length, newLists, results };
}

export async function previewHolidayImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  return check(tx, actor, bytes);
}

/** All or nothing: creates missing lists, adds new holidays, skips ones already there. */
export async function commitHolidayImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const p = await check(tx, actor, bytes);
  if (!p.valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  const batch = randomUUID();
  const listIds = new Map<string, string>();
  for (const l of await tx<{ id: string; name: string; year: number }[]>`select id, name, year from holiday_lists`) listIds.set(`${l.name.toLowerCase()}|${l.year}`, l.id);
  let added = 0, createdLists = 0;
  for (const r of p.results) {
    if (r.exists) continue;
    const key = `${r.list.toLowerCase()}|${r.year}`;
    let listId = listIds.get(key);
    if (!listId) {
      const [l] = await tx<{ id: string }[]>`insert into holiday_lists (tenant_id, name, year, floater_limit) values (${actor.tenant.id}, ${r.list}, ${r.year!}, 0) returning id`;
      listId = l.id; listIds.set(key, listId); createdLists++;
      await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'holiday_list', ${listId}, 'create', ${tx.json({ name: r.list, year: r.year, via: "import", batch })})`;
    }
    const ins = await tx`insert into holidays (tenant_id, holiday_list_id, name, date, is_floater, description) values (${actor.tenant.id}, ${listId}, ${r.name}, ${r.date!}, ${r.optional}, ${r.description})
                         on conflict (holiday_list_id, date, name) do nothing`;
    added += ins.count;
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'holiday_list', null, 'holidays.import', ${tx.json({ batch, rows: p.total, added, createdLists, skipped: p.skipped })})`;
  return { added, createdLists, skipped: p.skipped, rows: p.total };
}
