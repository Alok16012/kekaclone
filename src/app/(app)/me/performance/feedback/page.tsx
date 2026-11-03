import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myFeedback, teamFor } from "@/server/modules/performance/feedback";
import { peopleOptions } from "@/server/modules/performance/access";
import { FeedbackView } from "@/features/performance/feedback-view";

export const metadata: Metadata = { title: "Feedback" };

export default async function FeedbackPage(props: PageProps<"/me/performance/feedback">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [mine, team, people] = await Promise.all([myFeedback(tx, actor), teamFor(tx, actor), peopleOptions(tx)]);
    return { ...mine, team, people: people.filter((p) => p.id !== actor.employeeId), me: actor.employeeId };
  });
  const tab = typeof sp.tab === "string" ? sp.tab : "received";
  return <FeedbackView {...d} initialTab={tab} />;
}
