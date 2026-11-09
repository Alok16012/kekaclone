"use client";
import * as React from "react";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, t as translate, formatDate as fmtDate, formatNumber as fmtNumber, formatTime as fmtTime, type Locale, type MessageKey } from "./index";
import type { Vars } from "./index";

/*
 * Client side of i18n. Two sources, in order:
 *   1. <I18nProvider locale> around page content: the server read the cookie, so SSR and hydration agree.
 *   2. The app shell (rendered above any provider): a store initialised from the erp_lang cookie on the client, with
 *      English as the server snapshot. React swaps to the real locale right after hydration without a mismatch.
 */
const Ctx = React.createContext<Locale | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  React.useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <Ctx.Provider value={locale}>{children}</Ctx.Provider>;
}

const listeners = new Set<() => void>();
function readCookie(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const m = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  const v = m ? decodeURIComponent(m[1]) : null;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}
let cached: Locale | null = null;
const getSnapshot = () => (cached ??= readCookie());
const getServerSnapshot = () => DEFAULT_LOCALE;
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

/** Call after the language changes (the cookie was set by the server action). */
export function refreshLocale() { cached = null; for (const l of listeners) l(); }

export function useLocale(): Locale {
  const fromCtx = React.useContext(Ctx);
  const fromStore = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return fromCtx ?? fromStore;
}

/** t(key, vars) plus locale-aware formatters. */
export function useT() {
  const locale = useLocale();
  return React.useMemo(() => ({
    locale,
    t: (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    date: (iso: string, opts?: Intl.DateTimeFormatOptions) => fmtDate(locale, iso, opts),
    time: (iso: string) => fmtTime(locale, iso),
    number: (n: number, opts?: Intl.NumberFormatOptions) => fmtNumber(locale, n, opts),
  }), [locale]);
}
