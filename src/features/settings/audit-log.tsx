"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRight, CheckCircle2, ChevronRight, FilterX, History, LogIn, XCircle } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState } from "@/ui/feedback";
import { Field, Input } from "@/ui/field";
import { Drawer } from "@/ui/overlay";
import { Select } from "@/ui/select";
import { Tabs, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { diffLines, ENTITY_LABELS, showValue, type AuditFilters } from "@/server/modules/audit/rules";
import type { AuditItem, SignInItem } from "@/server/modules/audit/service";
import { moreAuditAction, moreSignInsAction } from "@/app/(app)/settings/audit/actions";

type Filters = AuditFilters & { result?: "success" | "failure" | null };
type Props = {
  tab: "activity" | "signins";
  filters: Filters;
  options: { people: Person[]; entities: string[]; actions: string[] };
  activity: { items: AuditItem[]; nextCursor: string | null; refs: Record<string, string> } | null;
  signins: { items: SignInItem[]; nextCursor: string | null } | null;
};

const ALL = "all";
const actionLabel = (a: string) => a.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Who did what and when: activity (audit_logs) and sign-in attempts, with filters in the URL and "Load more" paging. */
export function AuditLog({ tab, filters, options, activity, signins }: Props) {
  const router = useRouter();
  const path = usePathname();
  const [navigating, startNav] = React.useTransition();

  const go = (next: Partial<Filters> & { tab?: string }) => {
    const merged: Record<string, string | null | undefined> = { tab, ...filters, ...next };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v && !(k === "tab" && v === "activity")) qs.set(k, v);
    // filters that don't apply on the other tab are dropped when switching
    if (next.tab === "signins") { qs.delete("entity"); qs.delete("action"); }
    if (next.tab === "activity") qs.delete("result");
    startNav(() => router.push(qs.size ? `${path}?${qs}` : path));
  };
  const active = !!(filters.actor || filters.entity || filters.action || filters.from || filters.to || filters.result);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Audit log</h2>
        <p className="text-base text-text-muted">Every change made in erp and every sign-in attempt, newest first. Entries can&apos;t be edited or deleted.</p>
      </div>
      <Tabs value={tab} onValueChange={(v) => go({ tab: v })}>
        <TabsList items={[{ value: "activity", label: "Activity" }, { value: "signins", label: "Sign-ins" }]} />
      </Tabs>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
          <Field label="Person">
            <EmployeePicker people={options.people} value={filters.actor ? [filters.actor] : []} placeholder="Anyone"
              onChange={(ids) => go({ actor: ids[0] && ids[0] !== filters.actor ? ids[0] : null })} />
          </Field>
          {tab === "activity" ? (
            <>
              <Field label="Area">
                <Select value={filters.entity ?? ALL} onValueChange={(v) => go({ entity: v === ALL ? null : v })}
                  options={[{ value: ALL, label: "Everything" }, ...options.entities.map((e) => ({ value: e, label: ENTITY_LABELS[e] ?? actionLabel(e) }))]} />
              </Field>
              <Field label="Action">
                <Select value={filters.action ?? ALL} onValueChange={(v) => go({ action: v === ALL ? null : v })}
                  options={[{ value: ALL, label: "Any action" }, ...options.actions.map((a) => ({ value: a, label: actionLabel(a) }))]} />
              </Field>
            </>
          ) : (
            <Field label="Result" className="lg:col-span-2">
              <Select value={filters.result ?? ALL} onValueChange={(v) => go({ result: v === ALL ? null : (v as "success" | "failure") })}
                options={[{ value: ALL, label: "All attempts" }, { value: "success", label: "Signed in" }, { value: "failure", label: "Failed" }]} />
            </Field>
          )}
          <Field label="From"><Input type="date" value={filters.from ?? ""} max={filters.to ?? undefined} onChange={(e) => go({ from: e.target.value || null })} /></Field>
          <Field label="To"><Input type="date" value={filters.to ?? ""} min={filters.from ?? undefined} onChange={(e) => go({ to: e.target.value || null })} /></Field>
        </div>
        {active && (
          <div className="mt-3 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => go({ actor: null, entity: null, action: null, from: null, to: null, result: null })}><FilterX />Clear filters</Button>
          </div>
        )}
      </Card>

      <div aria-busy={navigating} className={cn("transition-opacity duration-fast", navigating && "pointer-events-none opacity-60")}>
        {tab === "activity" && activity && <ActivityList initial={activity} filters={filters} filtered={active} onClear={() => go({ actor: null, entity: null, action: null, from: null, to: null })} />}
        {tab === "signins" && signins && <SignInList initial={signins} filters={filters} filtered={active} onClear={() => go({ actor: null, from: null, to: null, result: null })} />}
      </div>
    </div>
  );
}

function toPlain(f: Filters): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
}

function usePaged<T>(initial: { items: T[]; nextCursor: string | null }, fetchMore: (cursor: string) => Promise<{ ok: true; data?: { items: T[]; nextCursor: string | null } } | { ok: false; error: string }>) {
  const [items, setItems] = React.useState(initial.items);
  const [cursor, setCursor] = React.useState(initial.nextCursor);
  const [loading, setLoading] = React.useState(false);
  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await fetchMore(cursor);
      if (!r.ok) { toast.error(r.error); return; }
      setItems((xs) => [...xs, ...(r.data?.items ?? [])]);
      setCursor(r.data?.nextCursor ?? null);
    } catch {
      toast.error("Couldn't load more entries. Check your connection and try again.");
    } finally { setLoading(false); }
  };
  return { items, cursor, loading, more };
}

function Footer({ cursor, loading, more, count }: { cursor: string | null; loading: boolean; more: () => void; count: number }) {
  return (
    <div className="flex items-center justify-center border-t border-border px-4 py-3">
      {cursor ? <Button variant="secondary" size="sm" loading={loading} onClick={more}>Load older entries</Button>
        : <p className="text-sm text-text-muted">{count === 1 ? "That's the only entry." : `That's all ${count} entries.`}</p>}
    </div>
  );
}

function ActivityList({ initial, filters, filtered, onClear }: { initial: NonNullable<Props["activity"]>; filters: Filters; filtered: boolean; onClear: () => void }) {
  const [refs, setRefs] = React.useState(initial.refs);
  const { items, cursor, loading, more } = usePaged(initial, async (c) => {
    const r = await moreAuditAction(toPlain(filters), c);
    if (r.ok && r.data) setRefs((x) => ({ ...x, ...r.data!.refs }));
    return r;
  });
  const [open, setOpen] = React.useState<AuditItem | null>(null);
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState icon={<History />} title={filtered ? "Nothing matches these filters" : "No activity yet"}
          description={filtered ? "Try a wider date range or another person." : "Changes to people, settings and approvals will appear here."}
          action={filtered ? <Button variant="secondary" size="sm" onClick={onClear}>Clear filters</Button> : undefined} />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul aria-label="Activity" className="divide-y divide-border">
        {items.map((it) => (
          <li key={it.id}>
            <button type="button" onClick={() => setOpen(it)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-focus/25">
              <Avatar name={it.actor_name ?? "System"} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block text-base"><strong className="font-semibold">{it.actor_name ?? "System"}</strong> {it.description}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
                  <time dateTime={it.at}>{it.when}</time>
                  <Badge>{ENTITY_LABELS[it.entity_type] ?? actionLabel(it.entity_type)}</Badge>
                </span>
              </span>
              <ChevronRight className="mt-1 size-4 shrink-0 text-text-muted" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <Footer cursor={cursor} loading={loading} more={more} count={items.length} />
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title="Change details" description={open ? open.when : undefined}>
        {open && <AuditDetail item={open} refs={refs} />}
      </Drawer>
    </Card>
  );
}

function AuditDetail({ item, refs }: { item: AuditItem; refs: Record<string, string> }) {
  const lines = diffLines(item.diff);
  const show = (v: unknown) => (typeof v === "string" && refs[v] ? refs[v] : showValue(v));
  return (
    <div className="flex flex-col gap-5">
      <p className="text-md"><strong className="font-semibold">{item.actor_name ?? "System"}</strong> {item.description}</p>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-base">
        <dt className="text-text-muted">Who</dt><dd className="min-w-0 break-words">{item.actor_name ?? "System"}{item.actor_email ? <span className="block text-sm text-text-muted">{item.actor_email}</span> : null}</dd>
        <dt className="text-text-muted">When</dt><dd><time dateTime={item.at}>{item.when}</time></dd>
        <dt className="text-text-muted">Area</dt><dd>{ENTITY_LABELS[item.entity_type] ?? actionLabel(item.entity_type)}{item.entity_label ? ` · ${item.entity_label}` : ""}</dd>
        <dt className="text-text-muted">Action</dt><dd><code className="rounded-xs bg-surface-sunken px-1 text-sm">{item.action}</code></dd>
        {item.ip && <><dt className="text-text-muted">IP address</dt><dd className="tabular">{item.ip}</dd></>}
      </dl>
      <section aria-label="What changed">
        <h3 className="mb-2 text-base font-semibold">What changed</h3>
        {lines.length === 0 ? <p className="text-base text-text-muted">No field-level details were recorded for this entry.</p> : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {lines.map((l) => (
              <li key={l.field} className="px-3 py-2">
                <p className="text-sm font-medium capitalize text-text-muted">{l.label}</p>
                {"value" in l ? <p className="break-words text-base">{show(l.value)}</p> : (
                  <p className="flex flex-wrap items-center gap-2 text-base">
                    <span className="break-all rounded-xs bg-danger-soft px-1.5 text-danger-text line-through decoration-1" aria-label="Before">{show(l.before)}</span>
                    <ArrowRight className="size-4 text-text-muted" aria-hidden />
                    <span className="break-all rounded-xs bg-success-soft px-1.5 text-success-text" aria-label="After">{show(l.after)}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {item.diff != null && (
        <details className="text-sm">
          <summary className="cursor-pointer text-text-muted hover:text-text">Raw record</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-xs">{JSON.stringify(item.diff, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function SignInList({ initial, filters, filtered, onClear }: { initial: NonNullable<Props["signins"]>; filters: Filters; filtered: boolean; onClear: () => void }) {
  const { items, cursor, loading, more } = usePaged(initial, (c) => moreSignInsAction(toPlain(filters), c));
  if (items.length === 0) {
    return (
      <Card>
        <EmptyState icon={<LogIn />} title={filtered ? "No sign-ins match these filters" : "No sign-ins yet"}
          description={filtered ? "Try a wider date range or another person." : "Each sign-in attempt, successful or not, is listed here."}
          action={filtered ? <Button variant="secondary" size="sm" onClick={onClear}>Clear filters</Button> : undefined} />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul aria-label="Sign-in attempts" className="divide-y divide-border">
        {items.map((s) => (
          <li key={s.id} className="flex items-start gap-3 px-4 py-3">
            <Avatar name={s.name ?? s.email ?? "?"} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-medium">{s.name ?? s.email ?? "Unknown email"}</p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
                <time dateTime={s.at}>{s.when}</time>
                {s.ip && <span className="tabular">IP {s.ip}</span>}
                {s.name && s.email && <span className="truncate">{s.email}</span>}
              </p>
            </div>
            {s.success ? <Badge tone="success"><CheckCircle2 aria-hidden />Signed in</Badge> : <Badge tone="danger"><XCircle aria-hidden />Failed</Badge>}
          </li>
        ))}
      </ul>
      <Footer cursor={cursor} loading={loading} more={more} count={items.length} />
    </Card>
  );
}
