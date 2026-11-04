"use client";
import * as React from "react";
import { BookOpen, ShieldCheck, Sparkles, ThumbsDown, ThumbsUp, Wand2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { askPoliciesAction, draftReplyAction, rateSuggestionAction, saveHelpdeskAssistantAction, type SuggestionDTO } from "@/app/(app)/helpdesk/assist-actions";

/** How the helpdesk assistant is running, for labels. */
export type HelpdeskAssistInfo = { suggest: boolean; active: boolean; provider: string | null };

const methodLabel = (s: SuggestionDTO) => (s.method === "ai" ? <Badge tone="accent"><Sparkles aria-hidden />AI answer</Badge> : <Badge tone="neutral">Matching passages</Badge>);

function Sources({ s }: { s: SuggestionDTO }) {
  return (
    <ol className="flex flex-col gap-1.5 text-sm">
      {s.citations.map((c) => (
        <li key={c.n} className="flex gap-2">
          <span className="tabular text-text-muted">[{c.n}]</span>
          <span className="min-w-0">
            {c.fileId ? <a href={`/files/${c.fileId}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">{c.title}</a> : <span className="font-medium">{c.title}</span>}
            <span className="block text-text-muted">{c.excerpt}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Before a ticket is raised: look for an answer in the company's policy documents. Never blocks raising the ticket.
 * `onResolved` is called when the person says the answer helped.
 */
export function PolicySuggest({ question, info, onResolved }: { question: string; info: HelpdeskAssistInfo; onResolved: () => void }) {
  const [s, setS] = React.useState<SuggestionDTO | null>(null);
  const [asked, setAsked] = React.useState("");
  const [rated, setRated] = React.useState(false);
  const [busy, start] = React.useTransition();
  if (!info.suggest) return null;
  const ask = () => start(async () => {
    const r = await askPoliciesAction(question);
    if (!r.ok) { toast.error(r.error); return; }
    setS(r.data!); setAsked(question); setRated(false);
  });
  const rate = (helpful: boolean) => start(async () => {
    if (!s) return;
    await rateSuggestionAction(s.id, helpful);
    setRated(true);
    if (helpful) { toast.success("Glad that helped. No ticket was raised."); onResolved(); }
  });
  const tooShort = question.trim().length < 8;
  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface-sunken p-3">
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen aria-hidden className="size-4 text-text-muted" />
        <p className="flex-1 text-sm">Your question may already be answered in a company policy.</p>
        <Button type="button" size="sm" variant="secondary" loading={busy && !s} disabled={tooShort || asked === question} onClick={ask}>Check policies</Button>
      </div>
      {s && (s.answer ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex items-center gap-2">{methodLabel(s)}<span className="text-xs text-text-muted">From documents you can see. Check the source before acting on it.</span></div>
          {s.notice && <p className="text-sm text-text-muted">{s.notice}</p>}
          <p className="whitespace-pre-line text-base">{s.answer}</p>
          <Sources s={s} />
          {!rated ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">Did this answer your question?</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => rate(true)}><ThumbsUp />Yes, no ticket needed</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => rate(false)}><ThumbsDown />No, raise the ticket</Button>
            </div>
          ) : <p className="text-sm text-text-muted">Thanks. You can still raise the ticket below.</p>}
        </div>
      ) : <p className="text-sm text-text-muted" aria-live="polite">No policy covers this. Go ahead and raise the ticket.</p>)}
    </div>
  );
}

/** For agents in a ticket: a draft reply from the policies the requester can see. It goes into the reply box; nothing is sent. */
export function DraftReplyButton({ ticketId, onDraft }: { ticketId: string; onDraft: (text: string) => void }) {
  const [s, setS] = React.useState<SuggestionDTO | null>(null);
  const [busy, start] = React.useTransition();
  const go = () => start(async () => {
    const r = await draftReplyAction(ticketId);
    if (!r.ok) { toast.error(r.error); return; }
    setS(r.data!);
    if (!r.data!.answer) toast.info("No policy document covers this ticket.");
    if (r.data!.notice) toast.info(r.data!.notice);
  });
  return (
    <div className="flex flex-col gap-2">
      <Button type="button" size="sm" variant="ghost" className="self-start" loading={busy} onClick={go}><Wand2 />Suggest a reply</Button>
      {s?.answer && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">{methodLabel(s)}<span className="text-xs text-text-muted">A draft for you to edit. It isn&apos;t sent.</span></div>
          <p className="whitespace-pre-line text-sm">{s.answer}</p>
          <Sources s={s} />
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => { onDraft(s.answer); setS(null); }}>Use this draft</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setS(null)}>Dismiss</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function HelpdeskAssistantSettings({ canEdit, aiEnabled, suggestBeforeRaise, provider, stats }: {
  canEdit: boolean; aiEnabled: boolean; suggestBeforeRaise: boolean; provider: string | null; stats: { asked: number; helped: number; not_helped: number };
}) {
  const [ai, setAi] = React.useState(aiEnabled);
  const [sug, setSug] = React.useState(suggestBeforeRaise);
  const [busy, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveHelpdeskAssistantAction({ aiEnabled: ai, suggestBeforeRaise: sug });
    if (r.ok) toast.success("Saved"); else toast.error(r.error);
  });
  return (
    <Card>
      <CardHeader title="Policy answers" description={provider ? `Answers are written by ${provider} from your policy documents.` : "No AI service is set up (ANTHROPIC_API_KEY isn't set), so answers are matching passages from your policy documents."} />
      <CardBody className="flex flex-col gap-3">
        <Switch checked={sug} disabled={!canEdit} onCheckedChange={(c) => setSug(!!c)} label="Suggest answers from policy documents before someone raises a ticket" />
        <Switch checked={ai} disabled={!canEdit} onCheckedChange={(c) => setAi(!!c)} label="Use AI to write answers and draft replies (when it's set up)" />
        <p className="flex items-start gap-1.5 text-sm text-text-muted"><ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />Only documents the person can already see are used. With AI on, their question and the matching extracts are sent to the AI service. Suggestions never close or change a ticket.</p>
        {stats.asked > 0 && <Banner tone="info">Last 30 days: {stats.asked} {stats.asked === 1 ? "question" : "questions"} checked, {stats.helped} answered without a ticket, {stats.not_helped} still needed one.</Banner>}
        {canEdit && <Button className="self-start" loading={busy} onClick={save}>Save</Button>}
      </CardBody>
    </Card>
  );
}
