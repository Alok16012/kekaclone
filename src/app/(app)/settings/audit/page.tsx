import type { Metadata } from "next";
import { ShieldAlert } from "lucide-react";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { auditFilterOptions, listAudit, listSignIns } from "@/server/modules/audit/service";
import { cleanFilters } from "@/server/modules/audit/rules";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { AuditLog } from "@/features/settings/audit-log";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage(props: PageProps<"/settings/audit">) {
  const sp = await props.searchParams;
  const tab = sp.tab === "signins" ? "signins" : "activity";
  const filters = cleanFilters(sp);
  const result = sp.result === "success" || sp.result === "failure" ? sp.result : null;
  const d = await load(async (tx, actor) => {
    if (!can(actor, "settings.audit")) return null;
    const options = await auditFilterOptions(tx, actor);
    if (tab === "signins") return { options, signins: await listSignIns(tx, actor, { ...filters, result }), activity: null };
    return { options, activity: await listAudit(tx, actor, filters), signins: null };
  });
  if (!d) {
    return (
      <Card>
        <EmptyState icon={<ShieldAlert />} title="You don't have access to the audit log"
          description="Ask a Global admin to give you a role with “View the audit log and sign-in history”." />
      </Card>
    );
  }
  const key = JSON.stringify({ tab, filters, result });
  return <AuditLog key={key} tab={tab} filters={{ ...filters, result }} options={d.options} activity={d.activity} signins={d.signins} />;
}
