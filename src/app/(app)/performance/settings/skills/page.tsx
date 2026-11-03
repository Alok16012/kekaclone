import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isPerfAdmin } from "@/server/modules/performance/access";
import { listCompetencies } from "@/server/modules/performance/settings";
import { AdminHeader } from "@/features/performance/admin-header";
import { SkillsLibrary } from "@/features/performance/skills-library";
import { NoAccess } from "@/features/performance/no-access";

export const metadata: Metadata = { title: "Skills and competencies" };

export default async function SkillsLibraryPage() {
  const d = await load(async (tx, actor) => (isPerfAdmin(actor) ? listCompetencies(tx) : null));
  if (!d) return <><AdminHeader title="Skills and competencies" admin={false} /><NoAccess what="The skills library" /></>;
  return (
    <>
      <AdminHeader title="Skills and competencies" description="The company's competencies, core values and skills. Review forms rate them; people add skills to their profiles." admin />
      <SkillsLibrary items={d} />
    </>
  );
}
