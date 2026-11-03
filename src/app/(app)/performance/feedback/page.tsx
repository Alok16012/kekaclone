import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { hasAnyPerf, isPerfAdmin } from "@/server/modules/performance/access";
import { feedbackSummary } from "@/server/modules/performance/feedback";
import { AdminHeader } from "@/features/performance/admin-header";
import { FeedbackSummary } from "@/features/performance/feedback-summary";
import { NoAccess } from "@/features/performance/no-access";
import { addDaysISO, todayIn } from "@/lib/dates";

export const metadata: Metadata = { title: "Feedback summary" };
const iso = /^\d{4}-\d{2}-\d{2}$/;

export default async function FeedbackSummaryPage(props: PageProps<"/performance/feedback">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const today = todayIn();   // after the request-time boundary in load(), never during prerender
    const to = typeof sp.to === "string" && iso.test(sp.to) ? sp.to : today;
    const from = typeof sp.from === "string" && iso.test(sp.from) && sp.from <= to ? sp.from : addDaysISO(to, -90);
    return hasAnyPerf(actor) ? { ...(await feedbackSummary(tx, actor, from, to)), admin: isPerfAdmin(actor), from, to } : null;
  });
  if (!d) return <><AdminHeader title="Feedback summary" admin={false} /><NoAccess what="The feedback summary" /></>;
  return (
    <>
      <AdminHeader title="Feedback summary" description="How much feedback and praise flows, and who isn't getting any. Contents stay private." admin={d.admin} />
      <FeedbackSummary {...d} />
    </>
  );
}
