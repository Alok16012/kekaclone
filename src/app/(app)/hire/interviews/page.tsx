import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myInterviews } from "@/server/modules/hire/interviews";
import { MyInterviews } from "@/features/hire/my-interviews";
import { HireHeader, hireTabs } from "../header";

export const metadata: Metadata = { title: "My interviews" };

export default async function MyInterviewsPage() {
  const d = await load(async (tx, actor) => {
    const [tabs, rows] = await Promise.all([hireTabs(tx, actor), myInterviews(tx, actor)]);
    return { tabs, rows };
  });
  return (
    <>
      <HireHeader tabs={d.tabs} title="My interviews" description="Interviews you're on the panel for, and feedback still to send." />
      <MyInterviews rows={d.rows} />
    </>
  );
}
