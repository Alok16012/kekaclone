"use client";
import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => { const t = setInterval(cb, 30_000); return () => clearInterval(t); };
const snapshot = () => Math.floor(Date.now() / 30_000) * 30_000;
const serverSnapshot = () => 0;

/** Current time (to 30 s) on the client; null while rendering on the server, so nothing reads the clock during prerender. */
export function useNow(): number | null {
  const n = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return n || null;
}

const IST: Intl.DateTimeFormatOptions = { timeZone: "Asia/Kolkata" };

/** "5 min ago" once the client knows the time, a fixed date before that (same on server and client). */
export function ago(iso: string, now: number | null) {
  const t = Date.parse(iso);
  if (now == null) return new Date(t).toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short" });
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString("en-IN", { ...IST, day: "numeric", month: "short", year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { ...IST, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { ...IST, weekday: "short", day: "numeric", month: "short" });
