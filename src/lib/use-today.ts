"use client";
import { useSyncExternalStore } from "react";

const subscribe = (cb: () => void) => { const t = setInterval(cb, 60_000); return () => clearInterval(t); };
const snapshot = () => new Date().toDateString();   // stable for the whole day
const serverSnapshot = () => "";

/** Today's date on the client, null during prerender/SSR, so no component reads the clock while rendering on the server. */
export function useToday(): Date | null {
  const s = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return s ? new Date(s) : null;
}
