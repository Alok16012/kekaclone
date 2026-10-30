"use client";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

/** Shared body for route error boundaries: says what happened and offers a retry. */
export function RouteError({ title, retry }: { title: string; retry: () => void }) {
  return (
    <Card>
      <EmptyState icon={<AlertTriangle />} title={title} description="Something went wrong while loading this page. Your data is safe."
        action={<Button variant="secondary" onClick={() => retry()}>Try again</Button>} />
    </Card>
  );
}
