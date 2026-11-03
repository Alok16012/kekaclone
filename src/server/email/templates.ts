/** Plain, inline-styled emails (email clients ignore stylesheets). Every email has a text version. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(company: string, heading: string, paragraphs: string[], button?: { label: string; url: string }, footnote?: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#14171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e5ea;border-radius:12px">
<tr><td style="padding:28px 28px 8px;font-size:13px;color:#535c68">${esc(company)} · erp</td></tr>
<tr><td style="padding:0 28px;font-size:22px;font-weight:600;line-height:28px">${esc(heading)}</td></tr>
${paragraphs.map((p) => `<tr><td style="padding:12px 28px 0;font-size:15px;line-height:22px">${p}</td></tr>`).join("")}
${button ? `<tr><td style="padding:24px 28px 8px"><a href="${esc(button.url)}" style="display:inline-block;background:#2f5bea;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:8px">${esc(button.label)}</a></td></tr>
<tr><td style="padding:8px 28px 0;font-size:12px;color:#535c68;word-break:break-all">Or open this link: ${esc(button.url)}</td></tr>` : ""}
<tr><td style="padding:24px 28px 28px;font-size:12px;line-height:18px;color:#535c68">${footnote ? esc(footnote) : "You're getting this because of your account at " + esc(company) + "."}</td></tr>
</table></td></tr></table></body></html>`;
  const strip = (p: string) => p.replace(/<[^>]+>/g, "");
  const text = [`${company} · erp`, "", heading, "", ...paragraphs.map(strip), ...(button ? ["", `${button.label}: ${button.url}`] : []), "", footnote ?? ""].join("\n").trim();
  return { html, text };
}

export function inviteEmail(p: { company: string; name: string; inviter: string | null; url: string; days: number }) {
  return {
    subject: `${p.company} invited you to erp`,
    ...layout(p.company, `Welcome, ${p.name.split(" ")[0]}`, [
      `${p.inviter ? esc(p.inviter) + " has" : "Your company has"} set up your account on erp, where you'll clock in, apply for leave and see your team.`,
      "Choose a password to get started.",
    ], { label: "Set my password", url: p.url }, `This link works for ${p.days} days. If you weren't expecting it, you can ignore this email.`),
  };
}

export function resetEmail(p: { company: string; name: string; url: string; minutes: number }) {
  return {
    subject: "Reset your erp password",
    ...layout(p.company, "Reset your password", [`Hi ${esc(p.name.split(" ")[0])}, someone (hopefully you) asked to reset your password.`],
      { label: "Choose a new password", url: p.url }, `This link works for ${p.minutes} minutes and only once. If you didn't ask for this, ignore this email; your password stays the same.`),
  };
}

export function loginCodeEmail(p: { company: string; name: string; code: string; minutes: number }) {
  return {
    subject: `${p.code} is your erp sign-in code`,
    ...layout(p.company, "Your sign-in code", [
      `Hi ${esc(p.name.split(" ")[0])}, use this code to finish signing in:`,
      `<span style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,monospace">${esc(p.code)}</span>`,
    ], undefined, `The code expires in ${p.minutes} minutes. If you didn't try to sign in, change your password.`),
  };
}

export function passwordChangedEmail(p: { company: string; name: string }) {
  return {
    subject: "Your erp password was changed",
    ...layout(p.company, "Password changed", [`Hi ${esc(p.name.split(" ")[0])}, your password was just changed and other devices were signed out.`],
      undefined, "If this wasn't you, contact your HR team right away."),
  };
}

export function trialEmail(p: { company: string; name: string; kind: "7d" | "1d" | "ended"; url: string }) {
  const heading = p.kind === "ended" ? "Your erp trial has ended" : p.kind === "1d" ? "Your erp trial ends tomorrow" : "Your erp trial ends in 7 days";
  return {
    subject: heading,
    ...layout(p.company, heading, [
      `Hi ${esc(p.name.split(" ")[0])},`,
      p.kind === "ended"
        ? `The free trial for ${esc(p.company)} is over. Plan features are paused until a plan is chosen; everyone's data and sign-ins are safe.`
        : `Thanks for trying erp with ${esc(p.company)}. Pick a plan before the trial ends so nothing is interrupted. Pricing is per employee per month, billed quarterly or yearly.`,
    ], { label: "Choose a plan", url: p.url }, "You're getting this because you're an admin of this workspace."),
  };
}

export function invoiceEmail(p: { company: string; name: string; number: string; total: string; url: string }) {
  return {
    subject: `Invoice ${p.number} from erp — ${p.total}`,
    ...layout(p.company, "Payment received", [
      `Hi ${esc(p.name.split(" ")[0])}, we've received ${esc(p.total)} for ${esc(p.company)}'s erp subscription. Invoice ${esc(p.number)} is ready in Settings → Billing.`,
    ], { label: "See invoices", url: p.url }, "GST is charged at 18%. Keep this invoice for your records."),
  };
}

/** Any in-app notification, as an email: what happened and a button to the page it concerns. */
export function notificationEmail(p: { company: string; name: string; title: string; body: string; url: string; eventLabel?: string }) {
  return {
    subject: `${p.title} · ${p.company}`,
    ...layout(p.company, p.title, [`Hi ${esc(p.name.split(" ")[0])},`, esc(p.body)], { label: "Open in erp", url: p.url },
      `You're getting this because of your account at ${p.company}. An admin can change which events are emailed under Settings → Notifications.`),
  };
}

/** One email per approver per day: everything still waiting for them, oldest first. */
export function digestEmail(p: { company: string; name: string; url: string; items: { kind: string; summary: string; ago: string }[] }) {
  const n = p.items.length;
  const rows = p.items.slice(0, 25).map((i) => `<div style="padding:8px 0;border-bottom:1px solid #e2e5ea"><span style="display:inline-block;min-width:96px;font-size:12px;color:#535c68;text-transform:uppercase">${esc(i.kind)}</span> ${esc(i.summary)} <span style="color:#535c68;font-size:12px">· ${esc(i.ago)}</span></div>`);
  if (n > 25) rows.push(`<div style="padding:8px 0;color:#535c68">… and ${n - 25} more</div>`);
  return {
    subject: `${n} ${n === 1 ? "request is" : "requests are"} waiting for you · ${p.company}`,
    ...layout(p.company, `${n} ${n === 1 ? "request" : "requests"} waiting for your decision`, [`Hi ${esc(p.name.split(" ")[0])}, here's what's in your inbox this morning:`, rows.join("")],
      { label: "Open my inbox", url: p.url }, "You get this digest once a day while something is waiting. An admin can turn it off under Settings → Notifications."),
  };
}
