import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myOnboarding, myTasks } from "@/server/modules/onboarding/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { MyTasks } from "@/features/onboarding/my-tasks";
import { OnboardingChecklist } from "@/features/onboarding/checklist";

export const metadata: Metadata = { title: "My tasks" };

export default async function MyTasksPage() {
  const d = await load(async (tx, actor) => {
    const today = todayIn();
    const [tasks, own] = await Promise.all([myTasks(tx, actor, today), myOnboarding(tx, actor, actor.employeeId, today)]);
    return { tasks, own, today };
  });
  return (
    <>
      <PageHeader title="My tasks" description="Things you've been asked to do to help new colleagues settle in." />
      <div className="flex flex-col gap-6">
        {d.own && d.own.tasks.length > 0 && <OnboardingChecklist data={d.own} />}
        <MyTasks open={d.tasks.open} done={d.tasks.done} />
      </div>
    </>
  );
}
