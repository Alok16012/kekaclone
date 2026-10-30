"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Calculator, LayoutList, Plus, Save, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { deleteStructureAction, saveStructureAction } from "@/app/(app)/settings/payroll/actions";
import { CALCS, computeBreakup, STRUCTURE_KINDS, type Calc, type ComponentKind } from "@/server/modules/payroll/rules";
import { CALC_LABEL, KIND_LABEL, money, rupeesToPaise } from "./labels";

type Line = { code: string; name: string; kind: ComponentKind; calc: Calc; value: string | null; formula: string | null };
export type StructureItem = { id: string; name: string; pay_group_id: string; pay_group: string; people: number; lines: Line[] };


export function StructuresList({ rows, groups, group }: { rows: StructureItem[]; groups: { id: string; name: string }[]; group: string | null }) {
  const router = useRouter();
  const shown = group ? rows.filter((r) => r.pay_group_id === group) : rows;
  return (
    <Card>
      <CardHeader title="Salary structures" description="How a CTC splits into components, for everyone on a pay group's structure."
        action={groups.length ? <Button asChild size="sm"><Link href={`/settings/payroll/structures/new${group ? `?group=${group}` : ""}`}><Plus />New structure</Link></Button> : undefined} />
      {groups.length > 1 && (
        <div className="border-t border-border px-5 py-3 sm:max-w-xs">
          <Field label="Pay group"><Select value={group ?? "all"} onValueChange={(v) => router.replace(v === "all" ? "?" : `?group=${v}`, { scroll: false })} options={[{ value: "all", label: "All pay groups" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} /></Field>
        </div>
      )}
      {!groups.length ? (
        <EmptyState compact icon={<LayoutList />} title="Add a pay group first" description="Structures belong to a pay group." action={<Button asChild size="sm"><Link href="/settings/payroll/pay-groups">Go to pay groups</Link></Button>} />
      ) : shown.length === 0 ? (
        <EmptyState compact icon={<LayoutList />} title="No structures yet" description="A structure turns a CTC into Basic, HRA, allowances and employer contributions." />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {shown.map((s) => (
            <li key={s.id}>
              <Link href={`/settings/payroll/structures/${s.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span className="truncate">{s.name}</span><Badge>{s.pay_group}</Badge></p>
                  <p className="truncate text-sm text-text-muted">{s.lines.map((l) => l.code).join(" · ") || "No components"} · {s.people} {s.people === 1 ? "person" : "people"}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type Comp = { id: string; code: string; name: string; kind: ComponentKind };
type EditLine = { key: string; componentId: string; calc: Calc; value: string; formula: string };

export function StructureEditor({ structure, components, groups, defaultGroup }: {
  structure: (Omit<StructureItem, "people" | "lines"> & { lines: (Line & { component_id: string })[] }) | null;
  components: Comp[]; groups: { id: string; name: string }[]; defaultGroup: string | null;
}) {
  const router = useRouter();
  const usable = components.filter((c) => STRUCTURE_KINDS.includes(c.kind));
  const [name, setName] = React.useState(structure?.name ?? "");
  const [groupId, setGroupId] = React.useState(structure?.pay_group_id ?? defaultGroup ?? groups[0]?.id ?? "");
  const [lines, setLines] = React.useState<EditLine[]>(() => (structure?.lines ?? []).map((l, i) => ({ key: String(i), componentId: l.component_id, calc: l.calc, value: l.value ? String(Number(l.value)) : "", formula: l.formula ?? "" })));
  const [sample, setSample] = React.useState("12,00,000");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const [adding, setAdding] = React.useState("");
  const seq = React.useRef(lines.length);

  const comp = (id: string) => usable.find((c) => c.id === id);
  const def = { lines: lines.filter((l) => comp(l.componentId)).map((l) => { const c = comp(l.componentId)!; return { code: c.code, name: c.name, kind: c.kind, calc: l.calc, value: l.value.replace(/,/g, ""), formula: l.formula }; }) };
  const samplePaise = rupeesToPaise(sample);
  const preview = samplePaise && samplePaise > 0 ? computeBreakup(def, samplePaise) : null;
  const errorFor = (code: string) => (preview && !preview.ok ? preview.errors.find((e) => e.code === code)?.message : undefined);
  const general = preview && !preview.ok ? preview.errors.filter((e) => !e.code) : [];

  const update = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const move = (i: number, d: number) => setLines((ls) => { const n = [...ls]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  const add = (id: string) => {
    if (!id) return;
    const c = comp(id)!;
    const hasBalancing = lines.some((l) => l.calc === "balancing");
    setLines((ls) => [...ls, { key: String(seq.current++), componentId: id, calc: c.kind === "earning" && !hasBalancing && c.code === "SPECIAL" ? "balancing" : "pct_ctc", value: "", formula: "" }]);
    setAdding("");
  };
  const save = () => start(async () => {
    setError(null);
    const r = await saveStructureAction(structure?.id ?? null, {
      name, payGroupId: groupId,
      lines: lines.map((l) => ({ componentId: l.componentId, calc: l.calc, value: l.calc === "flat" || l.calc === "pct_ctc" || l.calc === "pct_gross" ? l.value : null, formula: l.calc === "formula" ? l.formula : null })),
    });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(structure ? "Structure saved" : "Structure created", { description: structure ? "New salaries use it from now on. Existing salaries keep their saved breakup until revised." : undefined });
    if (!structure) router.replace(`/settings/payroll/structures/${r.data!.id}`);
  });
  const unused = usable.filter((c) => !lines.some((l) => l.componentId === c.id));

  return (
    <div className="flex flex-col gap-4">
      <div><Link href="/settings/payroll/structures" className="text-sm text-accent-text underline-offset-4 hover:underline">← All structures</Link></div>
      <Card>
        <CardHeader title={structure ? `Edit ${structure.name}` : "New salary structure"} description="Lines are worked out in the order they depend on each other, so you can list them however reads best." />
        <CardBody className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error.message}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={error?.field === "name" ? error.message : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Standard" /></Field>
            <Field label="Pay group" required><Select value={groupId} onValueChange={setGroupId} options={groups.map((g) => ({ value: g.id, label: g.name }))} /></Field>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader title="Components" description={<>Formulas use component codes in brackets, like <code className="font-mono">[BASIC] * 0.4</code>, plus <code className="font-mono">[CTC]</code> (monthly CTC), <code className="font-mono">[GROSS]</code> (CTC minus employer contributions), + − × ÷, brackets, min(), max() and round().</>} />
          {lines.length === 0 ? (
            <EmptyState compact icon={<Calculator />} title="No components yet" description="Add Basic first, then the rest. Make one earning the balancing line so everything adds up to CTC." />
          ) : (
            <ol className="divide-y divide-border border-t border-border">
              {lines.map((l, i) => {
                const c = comp(l.componentId);
                const err = c ? errorFor(c.code) : "This component can't be on a structure.";
                return (
                  <li key={l.key} className={cn("flex flex-col gap-3 px-5 py-3", err && "bg-danger-soft/40")}>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-base font-medium">{c?.name ?? "Unknown"}<Badge className="font-mono">{c?.code}</Badge>{c && <span className="text-sm font-normal text-text-muted">{KIND_LABEL[c.kind]}</span>}</p>
                      </div>
                      <IconButton label={`Move ${c?.name} up`} size="icon-sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></IconButton>
                      <IconButton label={`Move ${c?.name} down`} size="icon-sm" variant="ghost" disabled={i === lines.length - 1} onClick={() => move(i, 1)}><ArrowDown /></IconButton>
                      <IconButton label={`Remove ${c?.name}`} size="icon-sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><X /></IconButton>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[13rem_1fr]">
                      <Field label="Worked out as">
                        <Select value={l.calc} onValueChange={(v) => update(l.key, { calc: v as Calc })} options={CALCS.map((k) => ({ value: k, label: CALC_LABEL[k] }))} />
                      </Field>
                      {l.calc === "formula" ? (
                        <Field label="Formula" error={err}><Input value={l.formula} onChange={(e) => update(l.key, { formula: e.target.value })} maxLength={500} placeholder="[BASIC] * 0.4" className="font-mono" spellCheck={false} /></Field>
                      ) : l.calc === "balancing" ? (
                        <Field label="Amount" error={err}><p className="flex h-9 items-center text-base text-text-muted">Whatever is left of the monthly CTC</p></Field>
                      ) : (
                        <Field label={l.calc === "flat" ? "Monthly amount (₹)" : "Percentage"} error={err}>
                          <Input inputMode="decimal" value={l.value} onChange={(e) => update(l.key, { value: e.target.value })} className="tabular sm:max-w-40" trailing={l.calc === "flat" ? undefined : <span className="text-sm">%</span>} placeholder={l.calc === "flat" ? "1,600" : "50"} />
                        </Field>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="flex flex-wrap items-end gap-2 border-t border-border px-5 py-3">
            <Field label="Add a component" className="min-w-52 flex-1 sm:max-w-xs">
              <Select value={adding} onValueChange={add} placeholder={unused.length ? "Pick a component" : "Every component is on this structure"} disabled={!unused.length}
                options={unused.map((c) => ({ value: c.id, label: `${c.name} [${c.code}]` }))} />
            </Field>
            <Link href="/settings/payroll/components" className="pb-2 text-sm text-accent-text underline-offset-4 hover:underline">Manage components</Link>
          </div>
        </Card>

        <Card className="h-fit xl:sticky xl:top-4">
          <CardHeader title="Preview" description="Try a sample annual CTC. Nothing is saved." />
          <CardBody className="flex flex-col gap-3">
            <Field label="Annual CTC (₹)" error={sample && !samplePaise ? "Enter an amount like 12,00,000" : undefined}>
              <Input inputMode="decimal" value={sample} onChange={(e) => setSample(e.target.value)} className="tabular" />
            </Field>
            {!preview ? <p className="text-sm text-text-muted">Enter a CTC to see the monthly breakup.</p>
              : !preview.ok ? (
                <Banner tone="danger" title="Can't work this out yet">
                  <ul className="list-disc pl-4">{(general.length ? general : preview.errors).slice(0, 4).map((e, i) => <li key={i}>{e.message}</li>)}</ul>
                </Banner>
              ) : (
                <table className="w-full text-base">
                  <caption className="sr-only">Monthly breakup for the sample CTC</caption>
                  <thead className="text-left text-sm text-text-muted"><tr><th className="py-1 font-medium">Component</th><th className="py-1 text-right font-medium">Monthly</th><th className="hidden py-1 text-right font-medium sm:table-cell">Yearly</th></tr></thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={l.code} className="border-t border-border">
                        <td className="py-1.5">{l.name}{l.kind === "employer_contribution" && <span className="block text-xs text-text-muted">Employer contribution</span>}</td>
                        <td className="py-1.5 text-right tabular">{money(l.monthlyPaise)}</td>
                        <td className="hidden py-1.5 text-right tabular text-text-muted sm:table-cell">{money(l.annualPaise)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-border-strong font-medium"><td className="py-1.5">Gross</td><td className="py-1.5 text-right tabular">{money(preview.grossMonthlyPaise)}</td><td className="hidden py-1.5 text-right tabular sm:table-cell">{money(preview.grossMonthlyPaise * 12)}</td></tr>
                    <tr className="font-semibold"><td className="py-1.5">CTC</td><td className="py-1.5 text-right tabular">{money(preview.monthlyCtcPaise)}</td><td className="hidden py-1.5 text-right tabular sm:table-cell">{money(preview.monthlyCtcPaise * 12)}</td></tr>
                  </tbody>
                </table>
              )}
            <p className="text-xs text-text-muted">Each line is rounded to the rupee; the balancing line takes the remainder, so lines always add up to the monthly CTC.</p>
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {structure ? (
          <ConfirmDialog title={`Delete ${structure.name}?`} description="You can only delete a structure no one's salary uses. This can't be undone." confirmLabel="Delete"
            onConfirm={async () => { const r = await deleteStructureAction(structure.id); if (r.ok) { toast.success("Structure deleted"); router.replace("/settings/payroll/structures"); } else toast.error(r.error); }}
            trigger={<Button variant="ghost" size="sm"><Trash2 />Delete structure</Button>} />
        ) : <span />}
        <Button loading={pending} onClick={save} disabled={!lines.length || !groupId}><Save />{structure ? "Save structure" : "Create structure"}</Button>
      </div>
    </div>
  );
}

