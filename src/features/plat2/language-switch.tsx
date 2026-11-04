"use client";
import { Languages } from "lucide-react";
import { LOCALE_COOKIE, LOCALE_LABELS, LOCALES, type Locale } from "@/i18n";
import { useT } from "@/i18n/client";

/** Sign-in page language switch: sets the erp_lang cookie (the account's saved language replaces it after sign-in). */
export function LanguageSwitch({ locale }: { locale: Locale }) {
  const { t } = useT();
  return (
    <div className="mt-4 flex items-center justify-center gap-2 text-sm text-text-muted">
      <Languages className="size-4" aria-hidden />
      <label htmlFor="login-lang" className="sr-only">{t("login.language")}</label>
      <select id="login-lang" defaultValue={locale} className="rounded-sm border border-border bg-surface px-2 py-1 text-sm"
        onChange={(e) => { document.cookie = `${LOCALE_COOKIE}=${e.target.value}; path=/; max-age=${365 * 86400}; samesite=lax`; window.location.reload(); }}>
        {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_LABELS[l]}</option>)}
      </select>
    </div>
  );
}
