"use client";
import * as React from "react";
import Link from "next/link";
import { Award, ClipboardList, UserPlus, Users } from "lucide-react";
import { REVIEWER_LABEL, type ReviewerType } from "@/server/modules/performance/rules";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field } from "@/ui/field";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { decideNominationAction, nominatePeersAction } from "@/app/(app)/me/performance/actions";
import { fmtDate, ReviewStatusBadge } from "./bits";

type ToWrite = { id: string; cycle_id: string; cycle: string; status: string; reviewer_type: ReviewerType; reviewee_id: string; reviewee: string; due: string | null; cycle_status: string; rating: number | null };
type Nominate = { cycle_id: string; cycle: string; reviewee_id: string; reviewee: string; min: number; max: number; picked: number; due: string | null };
type Approval = { id: string; cycle: string; reviewee: string; peer: string };
type Result = { cycleId: string; cycle: string; rating: number | null; band: string | null; publishedAt: string | null; comments: { from: string; text: string }[] };

export function MyReviews({ toWrite, nominate, approvals, results, people, me, initialTab }: {
  toWrite: ToWrite[]; nominate: Nominate[]; approvals: Approval[]; results: Result[]; people: Person[]; me: string; initialTab: string;
}) {
  const [tab, setTab] = React.useState(initialTab === "team" ? "peers" : initialTab);
  const [picking, setPicking] = React.useState<Nominate | null>(null);
  const open = toWrite.filter((r) => r.status !== "submitted" && r.status !== "declined" && r.cycle_status === "live");
  const done = toWrite.filter((r) => !open.includes(r));
  const peerWork = nominate.filter((n) => n.picked < n.max).length + approvals.length;
  return (
    <>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[{ value: "write", label: "To write", count: open.length }, { value: "peers", label: "Peer reviewers", count: peerWork || undefined }, { value: "results", label: "My results", count: results.length || undefined }]} />
        <TabsContent value="write">
          {!toWrite.length ? <Card><EmptyState icon={<ClipboardList />} title="No reviews for you" description="When a review cycle starts, the reviews you need to write show up here." /></Card> : (
            <div className="flex flex-col gap-4">
              {open.length > 0 && <ReviewList title="Waiting for you" rows={open} me={me} />}
              {done.length > 0 && <ReviewList title="Done or closed" rows={done} me={me} />}
            </div>
          )}
        </TabsContent>
        <TabsContent value="peers">
          <div className="flex flex-col gap-4">
            {approvals.length > 0 && (
              <Card>
                <CardHeader title="Approve peer reviewers" description="Your team picked these colleagues to review them." />
                <ul className="divide-y divide-border border-t border-border">{approvals.map((a) => (
                  <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                    <p className="min-w-0 flex-1 text-base"><span className="font-medium">{a.peer}</span> <span className="text-text-muted">to review {a.reviewee} · {a.cycle}</span></p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={async () => { const r = await decideNominationAction(a.id, false); if (r.ok) toast.success("Not approved"); else toast.error(r.error); }}>Don&apos;t approve</Button>
                      <Button size="sm" onClick={async () => { const r = await decideNominationAction(a.id, true); if (r.ok) toast.success("Approved"); else toast.error(r.error); }}>Approve</Button>
                    </div>
                  </li>
                ))}</ul>
              </Card>
            )}
            {nominate.length > 0 ? (
              <Card>
                <CardHeader title="Pick peer reviewers" description="Colleagues who've worked closely with the person. Your manager may need to approve them." />
                <ul className="divide-y divide-border border-t border-border">{nominate.map((n) => (
                  <li key={n.cycle_id + n.reviewee_id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium">{n.reviewee_id === me ? "For you" : `For ${n.reviewee}`} <span className="font-normal text-text-muted">· {n.cycle}</span></p>
                      <p className="text-sm text-text-muted">{n.picked} of {n.min === n.max ? n.max : `${n.min}–${n.max}`} picked{n.due ? ` · by ${fmtDate(n.due)}` : ""}</p>
                    </div>
                    {n.picked < n.max && <Button size="sm" variant="secondary" onClick={() => setPicking(n)}><UserPlus />Pick peers</Button>}
                  </li>
                ))}</ul>
              </Card>
            ) : !approvals.length && <Card><EmptyState icon={<Users />} title="Nothing to do" description="When a cycle asks for peer reviewers, you pick them here." /></Card>}
          </div>
        </TabsContent>
        <TabsContent value="results">
          {!results.length ? <Card><EmptyState icon={<Award />} title="No results yet" description="Your rating and feedback appear here once HR publishes them." /></Card> : (
            <div className="flex flex-col gap-4">{results.map((r) => (
              <Card key={r.cycleId}>
                <CardHeader title={r.cycle} description={r.publishedAt ? `Published ${fmtDate(r.publishedAt)}` : undefined}
                  action={<div className="text-right"><p className="text-2xl font-semibold tabular">{r.rating ?? "—"}</p>{r.band && <Badge tone="accent">{r.band}</Badge>}</div>} />
                <CardBody>
                  {r.comments.length ? <ul className="flex flex-col gap-2">{r.comments.map((c, i) => <li key={i} className="rounded-md bg-surface-sunken px-3 py-2 text-base"><p className="text-sm font-medium text-text-muted">{c.from}</p><p className="whitespace-pre-line">{c.text}</p></li>)}</ul>
                    : <p className="text-sm text-text-muted">No written comments.</p>}
                </CardBody>
              </Card>
            ))}</div>
          )}
        </TabsContent>
      </Tabs>
      {picking && <PickPeers n={picking} people={people.filter((p) => p.id !== picking.reviewee_id && p.id !== me)} onClose={() => setPicking(null)} />}
    </>
  );
}

function ReviewList({ title, rows, me }: { title: string; rows: ToWrite[]; me: string }) {
  return (
    <Card>
      <CardHeader title={title} />
      <ul className="divide-y divide-border border-t border-border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-base font-medium">{r.reviewee_id === me ? "Self review" : `${r.reviewee}`} <span className="font-normal text-text-muted">· {r.reviewee_id === me ? r.cycle : `${REVIEWER_LABEL[r.reviewer_type]} review · ${r.cycle}`}</span></p>
              <p className="text-sm text-text-muted">{r.due ? `Due ${fmtDate(r.due)}` : "No due date"}{r.rating != null ? ` · your rating ${r.rating}` : ""}</p>
            </div>
            <ReviewStatusBadge status={r.status as "not_started"} />
            <Button size="sm" variant={r.status === "submitted" || r.cycle_status !== "live" ? "ghost" : "primary"} asChild>
              <Link href={`/me/performance/reviews/${r.id}`}>{r.status === "submitted" || r.cycle_status !== "live" ? "View" : r.status === "draft" ? "Continue" : "Start"}</Link>
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PickPeers({ n, people, onClose }: { n: Nominate; people: Person[]; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Pick peer reviewers" description={`${n.cycle} · up to ${n.max - n.picked} more`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        const r = await nominatePeersAction(n.cycle_id, n.reviewee_id, ids);
        setBusy(false);
        if (r.ok) { toast.success(r.data?.nomination === "proposed" ? "Sent to your manager to approve" : "Peers added"); onClose(); } else setErr(r.error);
      }}>Add</Button></>}>
      {err && <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
      <Field label="Colleagues"><EmployeePicker multiple people={people} value={ids} onChange={setIds} /></Field>
    </Modal>
  );
}
