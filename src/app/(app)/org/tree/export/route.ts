import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";
import { withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { orgAll } from "@/server/modules/corehr/people";
import { buildForest, layoutTree, toCsv } from "@/server/modules/corehr/rules";
import { todayIn } from "@/lib/dates";

/** Org chart as CSV (name, title, department, location, manager) or a drawn PDF, for the whole company or one branch. */
export async function GET(req: Request) {
  const actor = await getActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const url = new URL(req.url);
  const root = z.uuid().safeParse(url.searchParams.get("root")).data ?? null;
  const format = url.searchParams.get("format") === "pdf" ? "pdf" : "csv";
  const rows = await withTenant(actor.tenant.id, async (tx) => {
    await audit(tx, actor, { entityType: "employee", action: "org_chart.export", diff: { format, root } });
    return orgAll(tx);
  });
  const forest = buildForest(rows.map((r) => ({ id: r.id, name: r.name, title: r.title, manager_id: r.manager_id })), root);
  const name = `org-chart-${todayIn()}`;
  if (format === "csv") {
    const keep = new Set<string>();
    const walk = (ns: typeof forest) => ns.forEach((n) => { keep.add(n.id); walk(n.children); });
    walk(forest);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = [["Name", "Designation", "Department", "Location", "Reports to", "Direct reports"],
      ...rows.filter((r) => keep.has(r.id)).map((r) => [r.name, r.title ?? "", r.department ?? "", r.location ?? "", r.manager_id ? byId.get(r.manager_id)?.name ?? "" : "", r.reports])];
    return new Response("﻿" + toCsv(out), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "no-store" } });
  }
  const L = layoutTree(forest);
  const pad = 36, W = L.width + pad * 2, H = L.height + pad * 2 + 30;
  const scale = Math.min(1, 14000 / Math.max(W, H));   // PDF pages top out at 14,400pt
  const doc = await PDFDocument.create();
  const page = doc.addPage([Math.max(595, W * scale), Math.max(420, H * scale)]);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ascii = (s: string, n: number) => { const t = s.normalize("NFKD").replace(/[^\x20-\x7e]/g, ""); return t.length > n ? t.slice(0, n - 1) + "." : t; };
  const ph = page.getHeight();
  const Y = (y: number) => ph - (y + pad + 30) * scale;
  page.drawText(ascii(`${actor.tenant.name} - org chart, ${todayIn()}`, 80), { x: pad * scale, y: ph - 24 * scale - 8, size: 14 * scale + 2, font: bold, color: rgb(0.1, 0.12, 0.16) });
  const { w, h } = L.box;
  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  const line = rgb(0.6, 0.64, 0.68);
  for (const n of L.nodes) {
    if (!n.parent) continue;
    const p = byId.get(n.parent)!;
    const midY = p.y + h + (n.y - p.y - h) / 2;
    const px = (p.x + w / 2 + pad) * scale, nx = (n.x + w / 2 + pad) * scale;
    page.drawLine({ start: { x: px, y: Y(p.y + h) }, end: { x: px, y: Y(midY) }, thickness: 0.8, color: line });
    page.drawLine({ start: { x: px, y: Y(midY) }, end: { x: nx, y: Y(midY) }, thickness: 0.8, color: line });
    page.drawLine({ start: { x: nx, y: Y(midY) }, end: { x: nx, y: Y(n.y) }, thickness: 0.8, color: line });
  }
  for (const n of L.nodes) {
    page.drawRectangle({ x: (n.x + pad) * scale, y: Y(n.y + h), width: w * scale, height: h * scale, borderColor: rgb(0.78, 0.81, 0.85), borderWidth: 0.8, color: rgb(1, 1, 1) });
    page.drawText(ascii(n.name, 26), { x: (n.x + pad + 10) * scale, y: Y(n.y + 22), size: 11 * scale, font: bold, color: rgb(0.09, 0.13, 0.16) });
    if (n.title) page.drawText(ascii(n.title, 30), { x: (n.x + pad + 10) * scale, y: Y(n.y + 40), size: 9 * scale, font, color: rgb(0.36, 0.4, 0.45) });
  }
  const bytes = await doc.save();
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}.pdf"`, "cache-control": "no-store" } });
}
