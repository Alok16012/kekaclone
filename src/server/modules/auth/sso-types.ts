/** SSO provider names shared with client components (no crypto here). */
export type SsoProvider = "google" | "microsoft";
export const SSO_PROVIDERS: SsoProvider[] = ["google", "microsoft"];
export const isSsoProvider = (v: unknown): v is SsoProvider => v === "google" || v === "microsoft";
export const SSO_LABELS: Record<SsoProvider, string> = { google: "Google", microsoft: "Microsoft" };
