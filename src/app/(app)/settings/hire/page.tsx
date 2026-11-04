import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canAdminHire } from "@/server/modules/hire/access";
import * as setup from "@/server/modules/hire/setup";
import { calendarStatus } from "@/server/modules/hire/calendar";
import { HireSettings } from "@/features/hire/settings";
import { assistantState, hireSettings } from "@/server/modules/hire/assist";
import { privacyRequests } from "@/server/modules/hire/privacy";
import { HirePrivacy } from "@/features/hire/assist";

export const metadata: Metadata = { title: "Hiring settings" };

export default async function HireSettingsPage(props: PageProps<"/settings/hire">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const canEdit = canAdminHire(actor);
    const [flows, cards, jds, emails, offers, site, chains, fields, people] = await Promise.all([
      setup.listFlows(tx), setup.listScorecards(tx), setup.listJdTemplates(tx), setup.listEmailTemplates(tx), setup.listOfferTemplates(tx), setup.careerSite(tx),
      setup.approvalChains(tx), setup.candidateFields(tx),
      tx<{ id: string; name: string; title: string | null }[]>`select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id where e.status <> 'relieved' order by e.display_name`,
    ]);
    const [hs, assistant, requests] = await Promise.all([hireSettings(tx), assistantState(tx), canEdit ? privacyRequests(tx, actor) : Promise.resolve([])]);
    const privacy = { canEdit, aiEnabled: hs.ai_enabled, retentionMonths: hs.candidate_retention_months, assistant,
      requests: requests.map((r) => ({ ...r, created_at: r.created_at.toISOString(), decided_at: undefined })) };
    return { canEdit, flows, cards, jds, emails, offers, site, chains, fields, people, subdomain: actor.tenant.subdomain, privacy };
  });
  const { privacy, ...rest } = d;
  return <HireSettings {...rest} calendar={calendarStatus()} initialTab={typeof sp.tab === "string" ? sp.tab : "flows"} privacy={<HirePrivacy {...privacy} />} />;
}
