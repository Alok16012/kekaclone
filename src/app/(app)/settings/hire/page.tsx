import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canAdminHire } from "@/server/modules/hire/access";
import * as setup from "@/server/modules/hire/setup";
import { calendarStatus } from "@/server/modules/hire/calendar";
import { HireSettings } from "@/features/hire/settings";

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
    return { canEdit, flows, cards, jds, emails, offers, site, chains, fields, people, subdomain: actor.tenant.subdomain };
  });
  return <HireSettings {...d} calendar={calendarStatus()} initialTab={typeof sp.tab === "string" ? sp.tab : "flows"} />;
}
