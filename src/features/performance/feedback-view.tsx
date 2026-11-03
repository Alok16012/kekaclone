"use client";
import * as React from "react";
import Link from "next/link";
import { Award, Inbox, MessageSquarePlus, MessageSquareText, NotebookPen, Send, Sparkles, Trash2 } from "lucide-react";
import type { FeedbackRow, Visibility } from "@/server/modules/performance/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState } from "@/ui/feedback";
import { Avatar } from "@/ui/avatar";
import { toast } from "@/ui/toast";
import { addNoteAction, declineFeedbackAction, deleteFeedbackAction, feedbackAboutAction, giveFeedbackAction, requestFeedbackAction, respondFeedbackAction } from "@/app/(app)/me/performance/actions";
import { fmtDate } from "./bits";

const VIS: Record<Visibility, string> = { private: "Only them", manager: "Them and their manager", public: "Anyone in the company" };
type Praise = { id: string; from_name: string; body: string | null; badge: string | null; created_at: string };

export function FeedbackView({ received, given, requests, notes, praise, team, people, initialTab }: {
  received: FeedbackRow[]; given: FeedbackRow[]; requests: FeedbackRow[]; notes: FeedbackRow[]; praise: Praise[]; team: { id: string; name: string }[]; people: Person[]; me: string; initialTab: string;
}) {
  const [tab, setTab] = React.useState(initialTab);
  const [dialog, setDialog] = React.useState<"give" | "request" | "note" | null>(null);
  const [answering, setAnswering] = React.useState<FeedbackRow | null>(null);
  const pending = requests.filter((r) => r.status === "pending").length;
  return (
    <>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        {team.length > 0 && <Button variant="secondary" size="sm" onClick={() => setDialog("note")}><NotebookPen />Private note</Button>}
        <Button variant="secondary" size="sm" onClick={() => setDialog("request")}><Inbox />Ask for feedback</Button>
        <Button size="sm" onClick={() => setDialog("give")}><MessageSquarePlus />Give feedback</Button>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[
          { value: "received", label: "Received", count: received.length },
          { value: "requests", label: "Asked of me", count: pending || undefined },
          { value: "given", label: "Given & asked" },
          { value: "praise", label: "Praise", count: praise.length || undefined },
          ...(team.length ? [{ value: "team", label: "My team" }] : []),
        ]} />
        <TabsContent value="received">
          <List rows={received} empty="No feedback yet. Ask colleagues you've worked with — it's the quickest way to get some." render={(f) => <Item f={f} who={f.from_name} meta={VIS[f.visibility]} />} />
        </TabsContent>
        <TabsContent value="requests">
          <List rows={requests} empty="Nobody has asked you for feedback." render={(f) => (
            <Item f={f} who={f.from_name} meta={f.about_id && f.about_id !== f.from_id ? `About ${f.about_name}` : "About them"}
              actions={f.status === "pending" ? <div className="flex gap-2"><Button size="sm" variant="ghost" onClick={async () => { const r = await declineFeedbackAction(f.id); if (r.ok) toast.success("Declined"); else toast.error(r.error); }}>Decline</Button><Button size="sm" onClick={() => setAnswering(f)}>Answer</Button></div>
                : <Badge>{f.status === "done" ? "Answered" : "Declined"}</Badge>} />
          )} />
        </TabsContent>
        <TabsContent value="given">
          <List rows={given} empty="Nothing given or asked yet." render={(f) => (
            <Item f={f} who={f.kind === "request" ? `You asked ${f.to_name}${f.about_id !== f.from_id ? ` about ${f.about_name}` : ""}` : `To ${f.to_name}`}
              meta={f.kind === "request" ? (f.status === "pending" ? "Waiting for an answer" : f.status === "done" ? "Answered" : "Declined") : VIS[f.visibility]}
              actions={f.kind === "feedback" ? <DeleteOwn id={f.id} /> : undefined} />
          )} />
        </TabsContent>
        <TabsContent value="praise">
          {praise.length ? (
            <Card><ul className="divide-y divide-border">{praise.map((p) => (
              <li key={p.id} className="flex gap-3 px-5 py-3.5"><Avatar name={p.from_name} size="sm" />
                <div className="min-w-0"><p className="text-sm"><span className="font-medium">{p.from_name}</span> <span className="text-text-muted">{fmtDate(p.created_at)}</span>{p.badge && <Badge tone="accent" className="ml-2"><Award aria-hidden />{p.badge}</Badge>}</p>
                  {p.body && <p className="mt-1 whitespace-pre-line text-base">{p.body}</p>}</div></li>
            ))}</ul></Card>
          ) : <Card><EmptyState icon={<Sparkles />} title="No praise yet" description="Praise posted on the Home wall shows up here." action={<Button size="sm" variant="secondary" asChild><Link href="/home?compose=praise">Praise a colleague</Link></Button>} /></Card>}
        </TabsContent>
        {team.length > 0 && <TabsContent value="team"><TeamFeedback team={team} notes={notes} onNote={() => setDialog("note")} /></TabsContent>}
      </Tabs>
      {dialog === "give" && <GiveDialog people={people} onClose={() => setDialog(null)} />}
      {dialog === "request" && <RequestDialog people={people} team={team} onClose={() => setDialog(null)} />}
      {dialog === "note" && <NoteDialog team={team} onClose={() => setDialog(null)} />}
      {answering && <AnswerDialog req={answering} onClose={() => setAnswering(null)} />}
    </>
  );
}

function List({ rows, empty, render }: { rows: FeedbackRow[]; empty: string; render: (f: FeedbackRow) => React.ReactNode }) {
  if (!rows.length) return <Card><EmptyState icon={<MessageSquareText />} title="Nothing here yet" description={empty} /></Card>;
  return <Card><ul className="divide-y divide-border">{rows.map((f) => <li key={f.id}>{render(f)}</li>)}</ul></Card>;
}
function Item({ f, who, meta, actions }: { f: FeedbackRow; who: string; meta: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p className="text-sm"><span className="font-medium">{who}</span> <span className="text-text-muted">· {fmtDate(f.created_at)} · {meta}</span></p>
        {f.request_question && <p className="mt-1 text-sm text-text-muted">Asked: “{f.request_question}”</p>}
        {f.body && <p className="mt-1 whitespace-pre-line text-base">{f.body}</p>}
      </div>
      {actions}
    </div>
  );
}
function DeleteOwn({ id }: { id: string }) {
  return <ConfirmDialog trigger={<IconButton label="Delete this feedback" size="icon-sm"><Trash2 /></IconButton>} title="Delete this feedback?" description="It disappears for the person who received it too." confirmLabel="Delete"
    onConfirm={async () => { const r = await deleteFeedbackAction(id); if (r.ok) toast.success("Deleted"); else toast.error(r.error); }} />;
}

function TeamFeedback({ team, notes, onNote }: { team: { id: string; name: string }[]; notes: FeedbackRow[]; onNote: () => void }) {
  const [who, setWho] = React.useState(team[0]?.id ?? "");
  const [rows, setRows] = React.useState<{ id: string; v?: FeedbackRow[]; error?: string } | null>(null);
  React.useEffect(() => {
    if (!who) return;
    let live = true;
    feedbackAboutAction(who).then((r) => { if (live) setRows(r.ok ? { id: who, v: r.data } : { id: who, error: r.error }); });
    return () => { live = false; };
  }, [who, notes.length]);
  const s = rows?.id === who ? rows : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Person" className="w-64 max-w-full"><Select value={who} onValueChange={setWho} options={team.map((t) => ({ value: t.id, label: t.name }))} /></Field>
        <Button variant="secondary" size="sm" onClick={onNote}><NotebookPen />Add a note</Button>
      </div>
      <p className="text-sm text-text-muted">Feedback shared with managers, and your private notes. They never see the notes.</p>
      {!s ? <Card className="p-5"><p aria-busy className="text-sm text-text-muted">Loading…</p></Card> : s.error ? <p className="text-sm text-danger-text">{s.error}</p>
        : <List rows={s.v!} empty="Nothing shared about them yet." render={(f) => <Item f={f} who={f.kind === "internal_note" ? `Note by ${f.from_name}` : `From ${f.from_name}`} meta={f.kind === "internal_note" ? "Private note" : VIS[f.visibility]} />} />}
    </div>
  );
}

function useSubmit(onClose: () => void, ok: string) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { toast.success(ok); onClose(); } else setErr(r.error ?? "Something went wrong.");
  };
  return { busy, err, run };
}

function GiveDialog({ people, onClose }: { people: Person[]; onClose: () => void }) {
  const [to, setTo] = React.useState<string[]>([]);
  const [body, setBody] = React.useState("");
  const [vis, setVis] = React.useState<Visibility>("manager");
  const s = useSubmit(onClose, "Feedback sent");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Give feedback" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={s.busy} onClick={() => s.run(() => giveFeedbackAction({ toId: to[0], body, visibility: vis }))}><Send />Send</Button></>}>
      <div className="flex flex-col gap-4">
        {s.err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{s.err}</p>}
        <Field label="To" required><EmployeePicker people={people} value={to} onChange={setTo} /></Field>
        <Field label="Feedback" required help="Be specific: what happened, and the effect it had"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} /></Field>
        <Field label="Who can read it"><Select value={vis} onValueChange={(v) => setVis(v as Visibility)} options={(Object.keys(VIS) as Visibility[]).map((k) => ({ value: k, label: VIS[k] }))} /></Field>
      </div>
    </Modal>
  );
}

function RequestDialog({ people, team, onClose }: { people: Person[]; team: { id: string; name: string }[]; onClose: () => void }) {
  const [ask, setAsk] = React.useState<string[]>([]);
  const [about, setAbout] = React.useState("me");
  const [q, setQ] = React.useState("");
  const s = useSubmit(onClose, "Request sent");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Ask for feedback" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={s.busy} onClick={() => s.run(() => requestFeedbackAction({ askIds: ask, aboutId: about === "me" ? null : about, question: q }))}>Send request</Button></>}>
      <div className="flex flex-col gap-4">
        {s.err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{s.err}</p>}
        {team.length > 0 && <Field label="About"><Select value={about} onValueChange={setAbout} options={[{ value: "me", label: "Me" }, ...team.map((t) => ({ value: t.id, label: t.name }))]} /></Field>}
        <Field label="Ask" required help="Up to 10 people"><EmployeePicker multiple people={people.filter((p) => p.id !== about)} value={ask} onChange={setAsk} /></Field>
        <Field label="What would you like feedback on?" required><Textarea value={q} onChange={(e) => setQ(e.target.value)} rows={3} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}

function NoteDialog({ team, onClose }: { team: { id: string; name: string }[]; onClose: () => void }) {
  const [about, setAbout] = React.useState(team[0]?.id ?? "");
  const [body, setBody] = React.useState("");
  const s = useSubmit(onClose, "Note saved");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Private note" description="Only you, their other managers and HR can read it. They never see it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={s.busy} onClick={() => s.run(() => addNoteAction({ aboutId: about, body }))}>Save note</Button></>}>
      <div className="flex flex-col gap-4">
        {s.err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{s.err}</p>}
        <Field label="About"><Select value={about} onValueChange={setAbout} options={team.map((t) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="Note" required><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} maxLength={4000} /></Field>
      </div>
    </Modal>
  );
}

function AnswerDialog({ req, onClose }: { req: FeedbackRow; onClose: () => void }) {
  const [body, setBody] = React.useState("");
  const forManager = req.about_id !== req.from_id;
  const [vis, setVis] = React.useState<Visibility>("manager");
  const s = useSubmit(onClose, "Feedback sent");
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={forManager ? `Feedback about ${req.about_name}` : `Feedback for ${req.from_name}`} description={`“${req.body}”`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={s.busy} onClick={() => s.run(() => respondFeedbackAction(req.id, { body, visibility: vis }))}><Send />Send</Button></>}>
      <div className="flex flex-col gap-4">
        {s.err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{s.err}</p>}
        <Field label="Your feedback" required><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={4000} /></Field>
        <Field label="Who can read it" help={forManager ? `${req.from_name} asked as their manager, so they'll always see it.` : undefined}>
          <Select value={vis} onValueChange={(v) => setVis(v as Visibility)} options={(Object.keys(VIS) as Visibility[]).filter((k) => !forManager || k !== "private").map((k) => ({ value: k, label: VIS[k] }))} />
        </Field>
      </div>
    </Modal>
  );
}
