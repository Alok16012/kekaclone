/** Home extras: quick link rules. Pure (no I/O). */
export const MAX_QUICK_LINKS = 18;

/** A label people recognise and a plain http(s) link (no javascript:, data: or credentials in the URL). */
export function validateQuickLink(i: { label: string; url: string }): { ok: true; label: string; url: string } | { ok: false; error: string; field: string } {
  const label = i.label.trim();
  if (!label) return { ok: false, error: "Give the link a name.", field: "label" };
  if (label.length > 40) return { ok: false, error: "Keep the name under 40 characters.", field: "label" };
  let raw = i.url.trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = "https://" + raw;   // "intranet.acme.in" → https://
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: "Enter a full web address, like https://example.com.", field: "url" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, error: "Only web links (http or https) are allowed.", field: "url" };
  if (u.username || u.password) return { ok: false, error: "Don't put a username or password in the link.", field: "url" };
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return { ok: false, error: "Enter a full web address, like https://example.com.", field: "url" };
  if (u.href.length > 2000) return { ok: false, error: "This link is too long.", field: "url" };
  return { ok: true, label, url: u.href };
}

/** Short host shown under a link ("drive.google.com"). */
export const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
