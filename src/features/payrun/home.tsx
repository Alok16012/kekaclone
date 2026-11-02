"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";
import { createRunAction } from "@/app/(app)/payroll/actions";

/** Starts a run and opens it (the action returns the new id; navigation happens here, not in the action). */
export function StartRunButton({ payGroupId, month, label }: { payGroupId: string; month: string; label: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button loading={pending} onClick={() => start(async () => {
      const r = await createRunAction(payGroupId, month);
      if (!r.ok) { toast.error(r.error); return; }
      router.push(`/payroll/runs/${r.data!.id}`);
    })}><Play />{label}</Button>
  );
}
