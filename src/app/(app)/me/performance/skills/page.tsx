import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listCompetencies, skillsOf } from "@/server/modules/performance/settings";
import { MySkills } from "@/features/performance/my-skills";

export const metadata: Metadata = { title: "Skills" };

export default async function SkillsPage() {
  const d = await load(async (tx, actor) => {
    const [mine, library] = await Promise.all([skillsOf(tx, actor.employeeId), listCompetencies(tx, "skill")]);
    return { mine, library: library.map((c) => ({ id: c.id, name: c.name, description: c.description })) };
  });
  return <MySkills {...d} />;
}
