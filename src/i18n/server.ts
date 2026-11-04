import "server-only";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, t as translate, formatDate, formatNumber, formatTime, type Locale, type MessageKey, type Vars } from "./index";

/** The viewer's language from the erp_lang cookie (request-time read: only call inside a Suspense boundary / load()). */
export async function getLocale(): Promise<Locale> {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

/** Server-side translator for pages: const { t, locale } = await getT(). */
export async function getT() {
  const locale = await getLocale();
  return {
    locale,
    t: (key: MessageKey, vars?: Vars) => translate(locale, key, vars),
    date: (iso: string, opts?: Intl.DateTimeFormatOptions) => formatDate(locale, iso, opts),
    time: (iso: string) => formatTime(locale, iso),
    number: (n: number, opts?: Intl.NumberFormatOptions) => formatNumber(locale, n, opts),
  };
}

/** Cookie options shared by the language action and sign-in (one year, readable by the client store). */
export const LOCALE_COOKIE_OPTIONS = { httpOnly: false, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 86400 };
