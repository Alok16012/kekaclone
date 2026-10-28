import { Hammer } from "lucide-react";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

/** Placeholder for screens on the roadmap, so every nav link lands somewhere real. */
export function ComingSoon({ title, description, milestone }: { title: string; description: string; milestone: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card><EmptyState icon={<Hammer />} title="Being built" description={`This part of erp arrives in milestone ${milestone}.`} /></Card>
    </>
  );
}
