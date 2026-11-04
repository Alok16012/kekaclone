import Link from "next/link";
import { ChevronLeft, FileDown } from "lucide-react";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Card, CardBody, CardHeader } from "@/ui/card";
import type { PolicyDoc } from "@/server/modules/leave/policy-doc";

/** The leave policy as a readable page (server component). The PDF link renders the same sections. */
export function LeavePolicy({ doc, pdfHref, backHref, backLabel }: { doc: PolicyDoc; pdfHref: string; backHref: string; backLabel: string }) {
  return (
    <div className="flex flex-col gap-6">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"><ChevronLeft className="size-4" aria-hidden />{backLabel}</Link>
      <Card>
        <CardHeader title={`${doc.plan.name} leave policy`} description={`Generated on ${doc.generatedOn} from the rules in erp, so it always matches what the system applies.`}
          action={<Button asChild variant="secondary" size="sm"><a href={pdfHref} target="_blank" rel="noopener"><FileDown />Open as PDF</a></Button>} />
        <CardBody className="flex flex-col gap-3 text-base">
          {doc.intro.map((p, i) => <p key={i}>{p}</p>)}
        </CardBody>
      </Card>
      {doc.sections.length === 0 ? (
        <Card><CardBody className="text-base text-text-muted">This plan has no leave types yet.</CardBody></Card>
      ) : doc.sections.map((s) => (
        <Card key={s.code}>
          <CardHeader title={<span className="flex items-center gap-2"><span aria-hidden className="size-3 rounded-pill" style={{ background: s.color }} />{s.title}<Badge>{s.code}</Badge></span>} />
          <CardBody>
            <ul className="flex list-disc flex-col gap-2 pl-5 text-base">
              {s.lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </CardBody>
        </Card>
      ))}
      {doc.holidays.length > 0 && (
        <Card>
          <CardHeader title="Holidays" description="This year's holiday lists. Your own list depends on your location." />
          <CardBody><ul className="flex list-disc flex-col gap-1 pl-5 text-base">{doc.holidays.map((h, i) => <li key={i}>{h}</li>)}</ul></CardBody>
        </Card>
      )}
    </div>
  );
}
