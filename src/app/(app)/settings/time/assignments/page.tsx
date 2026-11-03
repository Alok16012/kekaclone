import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canAssignSomeone, listAssignments, listCapture, listPenalties, listShifts, listWeeklyOffs } from "@/server/modules/attendance/policies";
import { listOvertimePolicies } from "@/server/modules/attendance/overtime";
import { AssignmentsSettings } from "@/features/attendance/settings/assignments-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Time assignments" };

const pad = (t: { start: string; end: string } | undefined) => (t ? `${t.start}–${t.end}` : null);

export default async function AssignmentsPage() {
  const d = await load(async (tx, actor) => {
    if (!canAssignSomeone(actor)) return null;
    const today = todayIn();
    const [rows, shifts, offs, caps, pens, ots] = [await listAssignments(tx, actor, today), await listShifts(tx, today), await listWeeklyOffs(tx, today), await listCapture(tx), await listPenalties(tx), await listOvertimePolicies(tx)];
    return {
      rows, today,
      options: {
        shift: shifts.map((s) => ({ id: s.id, name: `${s.name} (${s.code})`, hint: [s.kind === "flexible" ? "Flexible" : null, pad(s.timings.mon ?? Object.values(s.timings)[0])].filter(Boolean).join(" · ") })),
        weekly_off: offs.map((o) => ({ id: o.id, name: o.name })),
        capture: caps.map((c) => ({ id: c.id, name: c.name, hint: c.is_default ? "Company default" : undefined })),
        penalty: pens.map((p) => ({ id: p.id, name: p.name })),
        overtime: ots.map((p) => ({ id: p.id, name: p.name, hint: p.rules.approval === "required" ? "Needs approval" : "Automatic" })),
      },
    };
  });
  return d ? <AssignmentsSettings rows={d.rows} options={d.options} today={d.today} /> : <NoAccess />;
}
