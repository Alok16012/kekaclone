"use client";
import * as React from "react";
import Link from "next/link";
import { Laptop } from "lucide-react";
import { exitAssetsAction } from "@/app/(app)/org/assets/actions";

type Item = { id: string; tag: string; name: string; type: string; assigned_at: string; acknowledged: boolean };

/** Read-only list under the exit checklist's "return assets" task: what the person still holds, with a link to take it back. */
export function ExitAssets({ employeeId }: { employeeId: string }) {
  const [state, setState] = React.useState<{ id: string; open?: Item[]; canManage?: boolean; error?: string } | null>(null);
  React.useEffect(() => {
    let live = true;
    exitAssetsAction(employeeId).then((r) => { if (live) setState(r.ok ? { id: employeeId, open: r.data!.open, canManage: r.data!.canManage } : { id: employeeId, error: r.error }); });
    return () => { live = false; };
  }, [employeeId]);
  const s = state?.id === employeeId ? state : null;
  if (!s) return <p className="mt-1 text-sm text-text-muted" aria-busy>Checking assets…</p>;
  if (s.error) return null;   // no access to assets: the task still works as a plain checkbox
  if (!s.open?.length) return <p className="mt-1 text-sm text-success-text">Nothing left to return.</p>;
  return (
    <div className="mt-1.5 rounded-md bg-surface-sunken px-3 py-2">
      <p className="text-sm font-medium">Still holding {s.open.length} {s.open.length === 1 ? "asset" : "assets"}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {s.open.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-sm"><Laptop className="size-3.5 shrink-0 text-text-muted" aria-hidden /><span className="tabular text-text-muted">{a.tag}</span><span className="min-w-0 truncate">{a.name}</span></li>
        ))}
      </ul>
      <Link href={s.canManage ? "/org/assets?tab=inventory" : `/people/${employeeId}`} className="mt-1 inline-block text-sm text-accent-text hover:underline">{s.canManage ? "Take them back in Assets" : "See their assets"}</Link>
    </div>
  );
}
