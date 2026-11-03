"use client";
import * as React from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Field } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { setSkillAction } from "@/app/(app)/me/performance/actions";

export const LEVELS = ["Learning", "Working knowledge", "Skilled", "Advanced", "Expert"];

/** The person's own skills (from the company list) with a 1–5 self-rating. Shown on their profile. */
export function MySkills({ mine, library }: { mine: { competency_id: string; name: string; proficiency: number }[]; library: { id: string; name: string; description: string | null }[] }) {
  const [adding, setAdding] = React.useState("");
  const [level, setLevel] = React.useState("3");
  const available = library.filter((l) => !mine.some((m) => m.competency_id === l.id));
  const save = async (id: string, p: number | null) => { const r = await setSkillAction(id, p); if (r.ok) toast.success(p == null ? "Removed" : "Saved"); else toast.error(r.error); };
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="My skills" description="Rate yourself honestly. Your manager and colleagues see these on your profile." />
        {!mine.length ? <EmptyState compact icon={<Sparkles />} title="No skills added" description="Pick from the company's skills list below." /> : (
          <ul className="divide-y divide-border border-t border-border">
            {mine.map((m) => (
              <li key={m.competency_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="min-w-0 flex-1 text-base font-medium">{m.name}</span>
                <div className="w-48"><Select size="sm" value={String(m.proficiency)} onValueChange={(v) => save(m.competency_id, Number(v))} options={LEVELS.map((l, i) => ({ value: String(i + 1), label: `${i + 1} · ${l}` }))} /></div>
                <IconButton label={`Remove ${m.name}`} size="icon-sm" onClick={() => save(m.competency_id, null)}><Trash2 /></IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-5">
        <h3 className="mb-3 text-md font-semibold">Add a skill</h3>
        {!available.length ? <p className="text-sm text-text-muted">{library.length ? "You've added every skill on the list." : "Your company hasn't set up a skills list yet."}</p> : (
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (!adding) return; await save(adding, Number(level)); setAdding(""); }}>
            <Field label="Skill" className="flex-1"><Select value={adding || undefined} placeholder="Pick a skill" onValueChange={setAdding} options={available.map((a) => ({ value: a.id, label: a.name }))} /></Field>
            <Field label="Level" className="sm:w-56"><Select value={level} onValueChange={setLevel} options={LEVELS.map((l, i) => ({ value: String(i + 1), label: `${i + 1} · ${l}` }))} /></Field>
            <Button type="submit" disabled={!adding}><Plus />Add</Button>
          </form>
        )}
        {adding && library.find((l) => l.id === adding)?.description && <p className="mt-2 text-sm text-text-muted">{library.find((l) => l.id === adding)!.description}</p>}
      </Card>
    </div>
  );
}
