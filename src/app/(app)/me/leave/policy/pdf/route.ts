import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { policyFor, policyPdf } from "@/server/modules/leave/policy-doc";

/** The signed-in person's leave policy as a PDF, generated from their plan's rules. */
export async function GET() {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const doc = await withTenant(actor.tenant.id, async (tx) => {
    const [e] = await tx<{ leave_plan_id: string | null }[]>`select leave_plan_id from employees where id = ${actor.employeeId}`;
    return e?.leave_plan_id ? policyFor(tx, e.leave_plan_id, todayIn()) : null;
  });
  if (!doc) return new Response("You're not on a leave plan yet.", { status: 404 });
  const bytes = await policyPdf(doc);
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="leave-policy.pdf"`, "cache-control": "private, no-store" } });
}
