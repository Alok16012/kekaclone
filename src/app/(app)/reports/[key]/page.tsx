import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { load } from "@/server/page-data";
import { canReadReports, filterOptions, library, runStandard } from "@/server/modules/reports/service";
import { PageHeader } from "@/ui/app-shell";
import { StandardReport } from "@/features/reports/report-view";

export const metadata: Metadata = { title: "Report" };

export default async function StandardReportPage(props: PageProps<"/reports/[key]">) {
  const { key } = await props.params;
  const sp = await props.searchParams;
  if (!/^[a-z_]{2,40}$/.test(key)) notFound();
  const raw: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && /^[a-z_]{1,40}$/.test(k)) raw[k] = v.slice(0, 80);
  const d = await load(async (tx, actor) => {
    if (!canReadReports(actor)) return null;
    const entry = library(actor).find((r) => r.key === key);
    if (!entry) return null;
    const [res, options] = await Promise.all([runStandard(tx, actor, key, raw), filterOptions(tx, entry)]);
    const rows = res.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "bigint" ? Number(v) : v])));
    return { entry, res, rows, options };
  });
  if (!d) notFound();
  return (
    <>
      <PageHeader title={d.entry.name} description={d.entry.description} />
      <StandardReport reportKey={d.entry.key} name={d.entry.name} description={d.entry.description} filters={d.entry.filters.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options }))}
        options={d.options} params={d.res.params} headers={d.res.headers} rows={d.rows} note={d.res.note} />
    </>
  );
}
