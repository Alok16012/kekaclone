import "server-only";
import type { Tx } from "@/server/db";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { queueEmail } from "@/server/email";
import { todayIn } from "@/lib/dates";
import { reminderDue, whenWords } from "@/server/modules/assist/rules";
import { candidateMail } from "./mail";
import { slotLabel } from "./rules";

const MODE = { online: "online", in_person: "in person", phone: "by phone" } as const;

/**
 * Daily job: a reminder for every scheduled interview starting in the next 24 hours, once (reminder_sent_at): the
 * candidate gets an email, each panelist an in-app notification and an email. Cancelled, moved-to-the-past and
 * removed-candidate interviews are skipped. Safe to run any number of times.
 */
export async function sendInterviewReminders(tx: Tx, tenantId: string, now = new Date()) {
  const rows = await tx<{ id: string; status: string; starts_at: Date | null; ends_at: Date | null; reminder_sent_at: Date | null; mode: keyof typeof MODE; meeting_url: string | null; location: string | null;
    title: string | null; first_name: string; email: string; anonymised_at: Date | null; job: string; company: string }[]>`
    select i.id, i.status, i.starts_at, i.ends_at, i.reminder_sent_at, i.mode, i.meeting_url, i.location, i.title, c.first_name, c.email::text, c.anonymised_at, j.title as job, t.name as company
    from interviews i join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id join jobs j on j.id = a.job_id join tenants t on t.id = i.tenant_id
    where i.status = 'scheduled' and i.reminder_sent_at is null and i.starts_at > ${now} and i.starts_at <= ${new Date(now.getTime() + 24 * 3600_000)} and a.status = 'active'
    for update of i skip locked`;
  let sent = 0;
  const today = todayIn("Asia/Kolkata", now);
  for (const r of rows) {
    if (!reminderDue(r, now) || !r.starts_at || !r.ends_at) continue;
    // claim first so a concurrent run can't send it twice
    const [claimed] = await tx<{ id: string }[]>`update interviews set reminder_sent_at = ${now} where id = ${r.id} and reminder_sent_at is null returning id`;
    if (!claimed) continue;
    if (r.anonymised_at) continue;
    const when = slotLabel({ start: r.starts_at, end: r.ends_at });
    const day = whenWords(todayIn("Asia/Kolkata", r.starts_at), today);
    const where = r.mode === "online" ? (r.meeting_url ? `Join here: ${r.meeting_url}` : "The meeting link will be shared by the hiring team.") : r.mode === "in_person" ? `Where: ${r.location ?? "the office"}` : "We'll call you on your mobile number.";
    await queueEmail(tx, tenantId, {
      kind: "hire.interview_reminder", to: r.email,
      ...candidateMail(r.company, `Reminder: your interview with ${r.company} ${day}`, `Hi ${r.first_name},\n\nA reminder about your interview for ${r.job}, ${when} (${MODE[r.mode]}).\n\n${where}\n\nIf you can't make it, reply to this email so we can find another time.`),
    });
    const panel = await tx<{ id: string; name: string; work_email: string }[]>`
      select e.id, e.display_name as name, e.work_email::text from interview_panelists p join employees e on e.id = p.employee_id where p.interview_id = ${r.id} and e.status <> 'relieved'`;
    for (const p of panel) {
      await notifyEmployee(tx, tenantId, p.id, "hire.interview_reminder", `Interview ${day}: ${r.first_name}`, `${r.job} · ${when}`, "/hire/interviews");
      await queueEmail(tx, tenantId, {
        kind: "hire.panel_reminder", to: p.work_email,
        ...candidateMail(r.company, `Reminder: interview with ${r.first_name} ${day}`, `Hi ${p.name.split(" ")[0]},\n\nYou're on the panel for ${r.first_name} (${r.job}), ${when} (${MODE[r.mode]}).\n\n${where}\n\nYour feedback form is under Hiring → My interviews.`),
      });
    }
    sent++;
  }
  return sent;
}
