"use client";
import * as React from "react";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/cn";

type Mail = { id: string; kind: string; to_email: string; subject: string; html: string; status: string; provider: string | null; created_at: string };

export function DevMailbox({ tenant, mails }: { tenant: string; mails: Mail[] }) {
  const [open, setOpen] = React.useState<string | null>(mails[0]?.id ?? null);
  const current = mails.find((m) => m.id === open);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-5 py-3">
        <h1 className="text-md font-semibold">Dev mailbox · {tenant}</h1>
        <Badge tone="warning">Local only, nothing is really sent</Badge>
      </header>
      <div className="grid flex-1 md:grid-cols-[22rem_1fr]">
        <ul className="divide-y divide-border border-r border-border bg-surface">
          {mails.length === 0 && <li className="p-5 text-base text-text-muted">No emails yet.</li>}
          {mails.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => setOpen(m.id)} className={cn("w-full px-5 py-3 text-left hover:bg-surface-sunken", open === m.id && "bg-accent-soft/50")}>
                <span className="block truncate text-base font-medium">{m.subject}</span>
                <span className="block truncate text-sm text-text-muted">to {m.to_email} · {m.kind} · {new Date(m.created_at).toLocaleTimeString("en-IN")}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-h-[60vh]">
          {current && <iframe title={current.subject} sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" srcDoc={current.html} className="size-full min-h-[70vh] bg-white" />}
        </div>
      </div>
    </div>
  );
}
