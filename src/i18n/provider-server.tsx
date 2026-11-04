import { getLocale } from "./server";
import { I18nProvider } from "./client";

/** Server side of the language provider: reads the cookie (request time, so render it inside Suspense). */
export async function LocaleProvider({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}
