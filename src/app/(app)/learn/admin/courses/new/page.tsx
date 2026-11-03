import type { Metadata } from "next";
import { Lock } from "lucide-react";
import { load } from "@/server/page-data";
import { canAdminLearn } from "@/server/modules/learn/service";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { NewCourse } from "@/features/learn/new-course";

export const metadata: Metadata = { title: "New course" };

export default async function NewCoursePage() {
  const d = await load(async (tx, actor) => ({ canEdit: canAdminLearn(actor) }));
  return (
    <>
      <PageHeader title="New course" description="Give it a title first; modules and assignment rules come next." />
      {d.canEdit ? <NewCourse /> : <Card><EmptyState icon={<Lock />} title="Only learning admins can author courses" /></Card>}
    </>
  );
}
