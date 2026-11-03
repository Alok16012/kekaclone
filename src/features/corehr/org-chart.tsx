"use client";
import * as React from "react";
import Link from "next/link";
import { Building2, ChevronDown, ChevronRight, Download, Loader2, Users } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Segmented } from "@/ui/choice";
import { Menu } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { departmentMembersAction, orgAllAction, orgChildrenAction } from "@/app/(app)/corehr/actions";
import { buildForest, layoutTree } from "@/server/modules/corehr/rules";

export type OrgNode = { id: string; name: string; title: string | null; department: string | null; location: string | null; manager_id: string | null; reports: number };
export type DeptNode = { id: string; name: string; parent_id: string | null; head: string | null; head_id: string | null; people: number };
type Mode = "top" | "me" | "departments";
/** File downloads from route handlers (not page navigations). */
export function download(href: string) { const a = document.createElement("a"); a.href = href; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); }

/**
 * Org chart as an expandable tree (works at phone width and with a keyboard). Children load when a branch is opened.
 * "From me" opens the chain of managers down to the viewer. Exports: PNG (drawn here), PDF and CSV (server).
 */
export function OrgChart({ roots, chain, preloaded, departments, meId, initialMode }: {
  roots: OrgNode[]; chain: OrgNode[]; preloaded: Record<string, OrgNode[]>; departments: DeptNode[]; meId: string; initialMode: Mode;
}) {
  const [mode, setMode] = React.useState<Mode>(initialMode);
  const [children, setChildren] = React.useState<Record<string, OrgNode[]>>(preloaded);
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(initialMode === "me" ? chain.filter((c) => c.id !== meId).map((c) => c.id) : []));
  const [loading, setLoading] = React.useState<Set<string>>(new Set());
  const [exporting, setExporting] = React.useState(false);

  const toggle = async (key: string, load: () => Promise<{ ok: boolean; data?: OrgNode[]; error?: string }>) => {
    if (open.has(key)) { setOpen((s) => { const n = new Set(s); n.delete(key); return n; }); return; }
    if (!children[key]) {
      setLoading((s) => new Set(s).add(key));
      const r = await load();
      setLoading((s) => { const n = new Set(s); n.delete(key); return n; });
      if (!r.ok) { toast.error(r.error ?? "Couldn't load this team."); return; }
      setChildren((c) => ({ ...c, [key]: r.data ?? [] }));
    }
    setOpen((s) => new Set(s).add(key));
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    if (m === "me") setOpen(new Set(chain.filter((c) => c.id !== meId).map((c) => c.id)));
  };
  const top = mode === "me" && chain.length ? [chain[0]] : roots;

  const exportPng = async () => {
    setExporting(true);
    try {
      const r = await orgAllAction();
      if (!r.ok) { toast.error(r.error); return; }
      const rows = r.data!.map((x) => ({ id: x.id, name: x.name, title: x.title, manager_id: x.manager_id }));
      const forest = buildForest(rows, mode === "me" && chain[0] ? chain[0].id : null);
      const L = layoutTree(forest);
      const pad = 24, { w, h } = L.box, W = L.width + pad * 2, H = L.height + pad * 2;
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
      const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
      const byId = new Map(L.nodes.map((n) => [n.id, n]));
      const lines = L.nodes.filter((n) => n.parent).map((n) => { const p = byId.get(n.parent!)!; const midY = p.y + h + (n.y - p.y - h) / 2;
        return `<path d="M${p.x + w / 2 + pad},${p.y + h + pad} V${midY + pad} H${n.x + w / 2 + pad} V${n.y + pad}" fill="none" stroke="#9aa3ad" stroke-width="1.2"/>`; }).join("");
      const boxes = L.nodes.map((n) => `<g transform="translate(${n.x + pad},${n.y + pad})"><rect width="${w}" height="${h}" rx="8" fill="#ffffff" stroke="#c9d0d8"/>`
        + `<text x="12" y="23" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#17202a">${esc(cut(n.name, 24))}</text>`
        + `<text x="12" y="42" font-family="system-ui, sans-serif" font-size="11" fill="#5b6672">${esc(cut(n.title ?? "", 28))}</text></g>`).join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#f6f7f9"/>${lines}${boxes}</svg>`;
      const scale = Math.min(2, 16000 / Math.max(W, H));
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("render")); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg); });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(W * scale); canvas.height = Math.ceil(H * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) throw new Error("png");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = "org-chart.png"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch {
      toast.error("Couldn't draw the picture. Try the PDF instead.");
    } finally { setExporting(false); }
  };
  const root = mode === "me" && chain[0] ? `&root=${chain[0].id}` : "";

  const person = (n: OrgNode, depth: number): React.ReactNode => {
    const isOpen = open.has(n.id), busy = loading.has(n.id), kids = children[n.id] ?? [];
    return (
      <li key={n.id} className="relative">
        <div className={cn("flex items-center gap-2 rounded-md border border-border bg-surface p-2 pr-3 shadow-card", n.id === meId && "border-accent ring-2 ring-accent-soft")}>
          {n.reports > 0 ? (
            <button type="button" onClick={() => toggle(n.id, () => orgChildrenAction(n.id))} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} ${n.name}'s ${n.reports} direct ${n.reports === 1 ? "report" : "reports"}`}
              className="flex size-7 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-hover">
              {busy ? <Loader2 className="size-4 animate-spin" /> : isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            </button>
          ) : <span className="size-7 shrink-0" aria-hidden />}
          <Avatar name={n.name} size="sm" />
          <div className="min-w-0 flex-1">
            <Link href={`/people/${n.id}`} className="block truncate text-base font-medium hover:underline">{n.name}</Link>
            <p className="truncate text-sm text-text-muted">{[n.title, n.department].filter(Boolean).join(" · ") || "—"}</p>
          </div>
          {n.reports > 0 && <Badge className="shrink-0"><Users />{n.reports}</Badge>}
          {n.id === meId && <Badge tone="accent" className="shrink-0">You</Badge>}
        </div>
        {isOpen && kids.length > 0 && (
          <ul className="ml-3 mt-2 flex flex-col gap-2 border-l border-border pl-3 sm:ml-5 sm:pl-5">{kids.map((k) => person(k, depth + 1))}</ul>
        )}
      </li>
    );
  };

  const deptChildren = (parent: string | null) => departments.filter((d) => d.parent_id === parent);
  const dept = (d: DeptNode): React.ReactNode => {
    const key = `dept:${d.id}`, isOpen = open.has(key), subs = deptChildren(d.id), members = children[key] ?? [];
    return (
      <li key={d.id}>
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken p-2 pr-3">
          <button type="button" onClick={() => toggle(key, () => departmentMembersAction(d.id))} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} ${d.name}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-hover">
            {loading.has(key) ? <Loader2 className="size-4 animate-spin" /> : isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
          <Building2 className="size-4 shrink-0 text-text-muted" aria-hidden />
          <div className="min-w-0 flex-1"><p className="truncate text-base font-semibold">{d.name}</p>{d.head && <p className="truncate text-sm text-text-muted">Head: {d.head}</p>}</div>
          <Badge className="shrink-0"><Users />{d.people}</Badge>
        </div>
        {isOpen && (
          <ul className="ml-3 mt-2 flex flex-col gap-2 border-l border-border pl-3 sm:ml-5 sm:pl-5">
            {subs.map(dept)}
            {members.map((m) => person({ ...m, reports: 0 }, 1))}
            {!subs.length && !members.length && <li className="text-sm text-text-muted">No one here yet.</li>}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Start the chart from" value={mode} onChange={switchMode} options={[{ value: "top" as const, label: "Top" }, { value: "me" as const, label: "Me" }, { value: "departments" as const, label: "By department" }]} />
        <Menu trigger={<Button variant="secondary" size="sm" loading={exporting}><Download />Export</Button>} items={[
          { label: "Picture (PNG)", onSelect: exportPng },
          { label: "PDF", onSelect: () => download(`/org/tree/export?format=pdf${root}`) },
          { label: "Spreadsheet (CSV)", onSelect: () => download(`/org/tree/export?format=csv${root}`) },
        ]} />
      </div>
      <Card className="p-3 sm:p-5">
        {mode === "departments" ? (
          departments.length === 0 ? <EmptyState compact icon={<Building2 />} title="No departments yet" description="Add departments in Settings → Company structure." /> : (
            <ul className="flex flex-col gap-2">{deptChildren(null).map(dept)}{departments.length > 0 && <li><button type="button" onClick={() => toggle("dept:none", () => departmentMembersAction(null))} className="text-sm font-medium text-accent-text hover:underline">{open.has("dept:none") ? "Hide people without a department" : "Show people without a department"}</button>
              {open.has("dept:none") && <ul className="mt-2 flex flex-col gap-2">{(children["dept:none"] ?? []).map((m) => person({ ...m, reports: 0 }, 1))}</ul>}</li>}</ul>
          )
        ) : top.length === 0 ? (
          <EmptyState compact icon={<Users />} title="No one here yet" description="Add people and set their managers to see the chart." />
        ) : (
          <ul className="flex flex-col gap-2">{top.map((n) => person(n, 0))}</ul>
        )}
      </Card>
    </div>
  );
}
