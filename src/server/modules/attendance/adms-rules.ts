/**
 * ZKTeco / eSSL "ADMS" push protocol (the devices call it iclock), pure parts. A device configured with our host as its
 * ADMS server does, by itself:
 *   GET  /iclock/cdata?SN=<serial>&options=all&pushver=…   handshake: we answer with the options block below
 *   POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=…    attendance logs, one per line: PIN \t TIME \t STATUS \t VERIFY …
 *   POST /iclock/cdata?SN=<serial>&table=OPERLOG…          operator logs (we acknowledge and ignore)
 *   GET  /iclock/getrequest?SN=<serial>                     polls for commands (we never send any: "OK")
 * Times are the device's local clock with no zone; the device's registered time zone and clock offset turn them into instants.
 */
import type { PunchItem } from "./device-rules";

export const ADMS_MAX_LINES = 5000;

/** The device's STATUS column: 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 overtime-in, 5 overtime-out; anything else = let processing decide. */
export function admsDirection(status: string | undefined): PunchItem["direction"] {
  switch ((status ?? "").trim()) {
    case "0": case "3": case "4": return "in";
    case "1": case "2": case "5": return "out";
    default: return "auto";
  }
}

/** Offset of `tz` from UTC at a given UTC instant, in minutes. */
function tzOffsetMinutes(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - at.getTime()) / 60000);
}

/** "2026-11-03 09:31:05" on a device in `tz`, running `clockOffsetSeconds` ahead of true time → the UTC instant. */
export function admsLocalToInstant(local: string, tz: string, clockOffsetSeconds = 0): Date | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(naive)) return null;
  let off: number;
  try { off = tzOffsetMinutes(new Date(naive), tz); off = tzOffsetMinutes(new Date(naive - off * 60000), tz); } catch { return null; }
  const at = new Date(naive - off * 60000 - clockOffsetSeconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

export type AdmsLine = { pin: string; time: string; status?: string; verify?: string; raw: string };

/** ATTLOG body → rows. Tab-separated; blank lines and lines without a PIN and time are skipped (reported as `bad`). */
export function parseAttlog(body: string): { rows: AdmsLine[]; bad: number } {
  const rows: AdmsLine[] = [];
  let bad = 0;
  for (const raw of body.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cols = raw.split("\t").map((c) => c.trim());
    const [pin, time, status, verify] = cols;
    if (!pin || !time || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(time) || pin.length > 60) { bad++; continue; }
    rows.push({ pin, time, status, verify, raw });
    if (rows.length >= ADMS_MAX_LINES) break;
  }
  return { rows, bad };
}

/** Rows → the same punch items the JSON push uses. external_id = PIN + device time, so a resent log counts once. */
export function attlogToPunches(rows: AdmsLine[], tz: string, clockOffsetSeconds = 0): { items: PunchItem[]; badTime: number } {
  const items: PunchItem[] = [];
  const seen = new Set<string>();
  let badTime = 0;
  for (const r of rows) {
    const at = admsLocalToInstant(r.time, tz, clockOffsetSeconds);
    if (!at) { badTime++; continue; }
    const external_id = `${r.pin}@${r.time.replace("T", " ").slice(0, 19)}`;
    if (seen.has(external_id)) continue;
    seen.add(external_id);
    items.push({ employee: r.pin, at: at.toISOString(), direction: admsDirection(r.status), external_id });
  }
  return { items, badTime };
}

/** Serial numbers are short identifiers printed on the device; anything else is noise or an attack. */
export function admsSerial(sn: string | null | undefined): string | null {
  const s = (sn ?? "").trim();
  return /^[A-Za-z0-9._-]{2,64}$/.test(s) ? s : null;
}

/** The handshake answer: push every change at once, no encryption, our stamps (0 = send everything you still have). */
export function admsOptions(serial: string, stamps: { attlog?: string | number | null; operlog?: string | number | null; tz?: string } = {}) {
  let tzHours = 5.5;
  try { tzHours = tzOffsetMinutes(new Date(), stamps.tz ?? "Asia/Kolkata") / 60; } catch { /* unknown zone: keep IST */ }
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGStamp=${stamps.attlog ?? 0}`,
    `OPERLOGStamp=${stamps.operlog ?? 0}`,
    "ATTPHOTOStamp=0",
    "ErrorDelay=30",
    "Delay=10",
    "TransTimes=00:00;14:05",
    "TransInterval=1",
    "TransFlag=TransData AttLog\tOpLog",
    "Realtime=1",
    "Encrypt=None",
    `TimeZone=${tzHours}`,
    "",
  ].join("\n");
}
