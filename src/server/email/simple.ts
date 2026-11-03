/** A plain notification email (heading, paragraphs, one button) with a text version. Used by reminders and scheduled reports. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function simpleEmail(p: { company: string; subject: string; heading: string; paragraphs: string[]; button?: { label: string; url: string }; footnote?: string }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#14171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e5ea;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:13px;color:#535c68">${esc(p.company)} · erp</td></tr>
<tr><td style="padding:0 28px;font-size:22px;font-weight:600;line-height:28px">${esc(p.heading)}</td></tr>
${p.paragraphs.map((t) => `<tr><td style="padding:12px 28px 0;font-size:15px;line-height:22px">${esc(t)}</td></tr>`).join("")}
${p.button ? `<tr><td style="padding:24px 28px 8px"><a href="${esc(p.button.url)}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">${esc(p.button.label)}</a></td></tr>
<tr><td style="padding:8px 28px 0;font-size:12px;color:#535c68;word-break:break-all">Or open this link: ${esc(p.button.url)}</td></tr>` : ""}
<tr><td style="padding:24px 28px 28px;font-size:12px;line-height:18px;color:#535c68">${esc(p.footnote ?? `You're getting this because of your account at ${p.company}.`)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [`${p.company} · erp`, "", p.heading, "", ...p.paragraphs, ...(p.button ? ["", `${p.button.label}: ${p.button.url}`] : []), "", p.footnote ?? ""].join("\n").trim();
  return { subject: p.subject, html, text };
}
