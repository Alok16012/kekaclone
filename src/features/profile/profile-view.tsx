"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRightLeft, Send, BadgeCheck, Briefcase, CalendarDays, Clock3, Hash, Mail, MapPin, Pencil, Phone, UserRound } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Banner, EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { ConfirmDialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import type { Profile } from "@/server/modules/employees/profile";
import { FIELD_LABELS } from "@/server/modules/employees/fields";
import { cancelJobChangeAction, inviteAction } from "@/app/(app)/actions";
import { EditSection, JobChangeDialog, ProbationDialog } from "./edit-dialogs";
import { MyCodeSwitch } from "@/features/settings/security-ui";
import type { Person } from "@/ui/employee-picker";

type Lookups = Parameters<typeof JobChangeDialog>[0]["lookups"];
const fmtDate = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null);
const LABEL: Record<string, string> = {
  female: "Female", male: "Male", non_binary: "Non-binary", undisclosed: "Prefer not to say", single: "Single", married: "Married", divorced: "Divorced", widowed: "Widowed",
  permanent: "Permanent", contract: "Contract", intern: "Intern", consultant: "Consultant", full_time: "Full time", part_time: "Part time",
};
const EVENT: Record<string, string> = {
  joined: "Joined", profile_updated: "Profile updated", transfer: "Transferred", promotion: "Promoted", manager_change: "Manager changed",
  designation_change: "Designation changed", other: "Job details changed", probation_confirmed: "Probation confirmed", probation_extended: "Probation extended", probation_in_probation: "Put on probation",
  exit_started: "Exit started", exited: "Left the company", rehired: "Rehired",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 py-2">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-base">{value ?? <span className="text-text-muted">Not added</span>}</dd>
    </div>
  );
}

function PersonLink({ p, label }: { p: { id: string; display_name: string; designation: string | null } | null; label?: string }) {
  if (!p) return <span className="text-text-muted">{label ?? "—"}</span>;
  return (
    <Link href={`/people/${p.id}`} className="inline-flex items-center gap-2 rounded-md hover:underline">
      <Avatar name={p.display_name} size="xs" /><span>{p.display_name}</span>{p.designation && <span className="text-sm text-text-muted">· {p.designation}</span>}
    </Link>
  );
}

function SectionCard({ title, edit, children }: { title: string; edit?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} action={edit} />
      <CardBody><dl className="divide-y divide-border">{children}</dl></CardBody>
    </Card>
  );
}

export function ProfileView({ p, lookups, today, currentManagerId, actions, banner, extraTabs = [], aboutExtra, profileExtra, jobExtra, initialTab }: {
  p: Profile; lookups: Lookups | null; today: string; currentManagerId: string | null;
  /** extra header buttons, a banner above the tabs, extra tabs and extra About cards, supplied by other modules (exits, documents, engage) */
  actions?: React.ReactNode; banner?: React.ReactNode; extraTabs?: { value: string; label: string; content: React.ReactNode }[]; aboutExtra?: React.ReactNode;
  /** more cards under the Profile tab (family, education, IDs, custom fields) and the Job tab (assigned policies) */
  profileExtra?: React.ReactNode; jobExtra?: React.ReactNode;
  /** open on this tab (from ?tab=), when it exists */
  initialTab?: string;
}) {
  const e = p.employee;
  const self = p.access === "self", admin = p.access === "admin";
  const canEdit = self || admin;
  const editBtn = (section: "personal" | "contact" | "addresses" | "about") =>
    canEdit ? <EditSection section={section} emp={e} self={self} trigger={<Button variant="ghost" size="sm" aria-label={`Edit ${section}`}><Pencil />Edit</Button>} /> : undefined;
  const addr = (k: "current" | "permanent") => {
    const a = e.addresses?.[k];
    const parts = a ? [a.line1, a.line2, a.city, a.state, a.pincode, a.country].filter(Boolean) : [];
    return parts.length ? parts.join(", ") : null;
  };
  const probation = e.probation_status === "in_probation" || e.probation_status === "extended";
  const jobHistory = p.timeline.filter((t) => ["joined", "rehired", "transfer", "promotion", "manager_change", "designation_change", "other", "exited"].includes(t.kind));

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <div className="h-20 bg-accent-soft" aria-hidden />
        <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
            <Avatar name={e.display_name} size="xl" className="-mt-10 w-fit self-start rounded-pill ring-4 ring-surface" />
            <div className="min-w-0">
              <h1 className="break-words text-2xl font-semibold tracking-tight">{e.display_name}</h1>
              <p className="text-base text-text-muted">{[e.designation, e.department].filter(Boolean).join(" · ") || "No designation yet"}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {e.status === "active" ? <Badge tone="success">Active</Badge> : e.status === "notice" ? <Badge tone="warning">Serving notice</Badge> : e.status === "relieved" ? <Badge>Exited</Badge> : <Badge>{e.status}</Badge>}
                {probation && <Badge tone="warning">In probation{e.probation_end_date ? ` till ${fmtDate(e.probation_end_date)}` : ""}</Badge>}
                {e.probation_status === "confirmed" && <Badge tone="accent"><BadgeCheck />Confirmed</Badge>}
                <Badge>{LABEL[e.worker_type] ?? e.worker_type}</Badge>
                {e.login === "invited" && <Badge tone="accent">Invited, not signed in yet</Badge>}
                {e.login === "not_invited" && <Badge>Not invited</Badge>}
              </div>
            </div>
          </div>
          {((admin && lookups) || actions) && (
            <div className="flex flex-wrap gap-2">
              {actions}
              {admin && e.login && e.login !== "active" && e.login !== "disabled" && (
                <Button variant="secondary" size="sm" onClick={async () => {
                  const r = await inviteAction([e.id]);
                  if (r.ok && r.data!.sent) toast.success(e.login === "invited" ? "Invite sent again" : "Invite sent", { description: e.work_email });
                  else toast.error(r.ok ? r.data!.skipped[0]?.reason ?? "Not sent" : r.error);
                }}><Send />{e.login === "invited" ? "Resend invite" : "Send invite"}</Button>
              )}
              {admin && lookups && <ProbationDialog emp={e} today={today} trigger={<Button variant="secondary" size="sm"><BadgeCheck />Probation</Button>} />}
              {admin && lookups && <JobChangeDialog emp={e} current={{ manager_id: currentManagerId }} lookups={lookups} today={today} trigger={<Button size="sm"><ArrowRightLeft />Change job</Button>} />}
            </div>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-2 border-t border-border px-5 py-4 text-base sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex min-w-0 items-center gap-2"><Mail className="size-4 shrink-0 text-text-muted" aria-hidden /><dt className="sr-only">Work email</dt><dd className="truncate"><a href={`mailto:${e.work_email}`} className="hover:underline">{e.work_email}</a></dd></div>
          {e.contact?.mobile && <div className="flex items-center gap-2"><Phone className="size-4 text-text-muted" aria-hidden /><dt className="sr-only">Mobile</dt><dd>{e.contact.mobile}</dd></div>}
          <div className="flex items-center gap-2"><MapPin className="size-4 text-text-muted" aria-hidden /><dt className="sr-only">Location</dt><dd>{e.location ?? "—"}</dd></div>
          <div className="flex items-center gap-2"><Hash className="size-4 text-text-muted" aria-hidden /><dt className="sr-only">Employee number</dt><dd className="tabular">{e.employee_number}</dd></div>
          <div className="flex items-center gap-2"><CalendarDays className="size-4 text-text-muted" aria-hidden /><dt className="sr-only">Joined</dt><dd>Joined {fmtDate(e.joining_date)}</dd></div>
          <div className="flex min-w-0 items-center gap-2"><UserRound className="size-4 shrink-0 text-text-muted" aria-hidden /><dt className="sr-only">Reports to</dt><dd className="min-w-0 truncate">Reports to <PersonLink p={p.manager} label="no one" /></dd></div>
        </dl>
      </Card>

      {p.pendingChanges.length > 0 && (
        <Banner tone="warning" title={self ? "Waiting for HR" : "Changes waiting for approval"}>
          {p.pendingChanges.map((c) => Object.keys(c.changes).map((k) => FIELD_LABELS[k] ?? k).join(", ")).join("; ")}{self ? " will update once HR approves." : "."}
        </Banner>
      )}

      {banner}

      <Tabs defaultValue={initialTab && ["profile", "job", "timeline", ...extraTabs.map((t) => t.value)].includes(initialTab) ? initialTab : "about"}>
        <TabsList items={[{ value: "about", label: "About" }, ...(p.employee.personal ? [{ value: "profile", label: "Profile" }] : []), { value: "job", label: "Job" }, ...(p.timeline.length ? [{ value: "timeline", label: "Timeline" }] : []), ...extraTabs.map((t) => ({ value: t.value, label: t.label }))]} />

        <TabsContent value="about">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="About" action={editBtn("about")} />
              <CardBody className="flex flex-col gap-4">
                {!e.bio.summary && !e.bio.loveAboutJob && !e.bio.hobbies ? (
                  <EmptyState compact title={self ? "Tell your colleagues about yourself" : "Nothing here yet"} description={self ? "A few lines about your work and interests help new teammates get to know you." : undefined} />
                ) : (
                  <>
                    {e.bio.summary && <p className="whitespace-pre-line text-base">{e.bio.summary}</p>}
                    {e.bio.loveAboutJob && <div><h4 className="text-sm font-semibold">What I enjoy about my work</h4><p className="mt-1 whitespace-pre-line text-base text-text-muted">{e.bio.loveAboutJob}</p></div>}
                    {e.bio.hobbies && <div><h4 className="text-sm font-semibold">Interests and hobbies</h4><p className="mt-1 whitespace-pre-line text-base text-text-muted">{e.bio.hobbies}</p></div>}
                  </>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Team" />
              <CardBody className="flex flex-col gap-4">
                <div><p className="mb-1.5 text-sm text-text-muted">Reports to</p><PersonLink p={p.manager} label="No manager" /></div>
                {p.reportees.length > 0 && <div><p className="mb-1.5 text-sm text-text-muted">Direct reports · {p.reportees.length}</p><ul className="flex flex-col gap-1.5">{p.reportees.map((r) => <li key={r.id}><PersonLink p={r} /></li>)}</ul></div>}
                {p.peers.length > 0 && <div><p className="mb-1.5 text-sm text-text-muted">Works with</p><ul className="flex flex-col gap-1.5">{p.peers.map((r) => <li key={r.id}><PersonLink p={r} /></li>)}</ul></div>}
              </CardBody>
            </Card>
            {aboutExtra}
          </div>
        </TabsContent>

        {e.personal && (
          <TabsContent value="profile">
            <div className="grid gap-4 lg:grid-cols-2">
              <SectionCard title="Personal details" edit={editBtn("personal")}>
                <Row label="Date of birth" value={fmtDate(e.personal.dob)} />
                <Row label="Gender" value={e.personal.gender ? LABEL[e.personal.gender] : null} />
                <Row label="Marital status" value={e.personal.marital_status ? LABEL[e.personal.marital_status] : null} />
                <Row label="Blood group" value={e.personal.blood_group} />
                <Row label="Nationality" value={e.personal.nationality} />
              </SectionCard>
              <SectionCard title="Contact details" edit={editBtn("contact")}>
                <Row label="Work email" value={e.work_email} />
                <Row label="Personal email" value={e.contact?.personal_email} />
                <Row label="Mobile" value={e.contact?.mobile} />
              </SectionCard>
              <SectionCard title="Addresses" edit={editBtn("addresses")}>
                <Row label="Current" value={addr("current")} />
                <Row label="Permanent" value={addr("permanent")} />
              </SectionCard>
              {p.security && <MyCodeSwitch mode={p.security.mode} mine={p.security.mine} />}
            </div>
            {profileExtra}
          </TabsContent>
        )}

        <TabsContent value="job">
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Employment">
              <Row label="Employee number" value={<span className="tabular">{e.employee_number}</span>} />
              <Row label="Joining date" value={fmtDate(e.joining_date)} />
              <Row label="Worker type" value={LABEL[e.worker_type] ?? e.worker_type} />
              <Row label="Time type" value={LABEL[e.time_type] ?? e.time_type} />
              <Row label="Probation" value={probation ? `Until ${fmtDate(e.probation_end_date) ?? "—"}` : e.probation_status === "confirmed" ? `Confirmed${e.probation_end_date ? ` on ${fmtDate(e.probation_end_date)}` : ""}` : "Not applicable"} />
            </SectionCard>
            <SectionCard title="Organisation">
              <Row label="Designation" value={e.designation} />
              <Row label="Department" value={e.department} />
              <Row label="Location" value={e.location} />
              <Row label="Business unit" value={e.business_unit} />
              <Row label="Legal entity" value={e.legal_entity} />
              <Row label="Reports to" value={<PersonLink p={p.manager} label="No manager" />} />
              {p.l2Manager && <Row label="Second-level manager" value={<PersonLink p={p.l2Manager} />} />}
              {p.dottedManager && <Row label="Dotted-line manager" value={<PersonLink p={p.dottedManager} />} />}
            </SectionCard>
            {jobExtra}
            {p.scheduledChanges.length > 0 && (
              <Card className="lg:col-span-2">
                <CardHeader title="Scheduled changes" description="Applied automatically on the effective date" />
                <ul className="divide-y divide-border">
                  {p.scheduledChanges.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                      <Clock3 className="size-4 text-warning" aria-hidden />
                      <span className="flex-1 text-base">{EVENT[c.kind] ?? c.kind} on {fmtDate(c.effective_date)}</span>
                      <ConfirmDialog title="Cancel this scheduled change?" description="Nothing will change on the effective date." confirmLabel="Cancel change"
                        onConfirm={async () => { const r = await cancelJobChangeAction(c.id); if (r.ok) toast.success("Scheduled change cancelled"); else toast.error(r.error); }}
                        trigger={<Button variant="ghost" size="sm">Cancel</Button>} />
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {jobHistory.length > 0 && (
              <Card className="lg:col-span-2">
                <CardHeader title="Job history" />
                <ul className="divide-y divide-border">
                  {jobHistory.map((t, i) => (
                    <li key={i} className="flex items-center gap-3 px-5 py-3">
                      <Briefcase className="size-4 text-text-muted" aria-hidden />
                      <span className="flex-1 text-base">{EVENT[t.kind] ?? t.kind}{typeof t.data?.note === "string" && t.data.note ? <span className="text-text-muted"> · {t.data.note}</span> : null}</span>
                      <span className="text-sm text-text-muted tabular">{fmtDate(t.effective_date)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        </TabsContent>

        {p.timeline.length > 0 && (
          <TabsContent value="timeline">
            <Card>
              <ol className="relative flex flex-col gap-0 px-5 py-4">
                {p.timeline.map((t, i) => (
                  <li key={i} className="relative flex gap-4 pb-5 last:pb-0">
                    {i < p.timeline.length - 1 && <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-border" />}
                    <span aria-hidden className="relative z-10 mt-1.5 size-2.5 shrink-0 rounded-pill bg-accent ring-4 ring-surface" />
                    <div className="min-w-0">
                      <p className="text-base font-medium">{EVENT[t.kind] ?? t.kind}</p>
                      <p className="text-sm text-text-muted">{fmtDate(t.effective_date)}{t.actor ? ` · by ${t.actor}` : ""}{Array.isArray(t.data?.fields) ? ` · ${(t.data.fields as string[]).map((f) => FIELD_LABELS[f] ?? f).join(", ")}` : ""}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </TabsContent>
        )}
        {extraTabs.map((t) => <TabsContent key={t.value} value={t.value}>{t.content}</TabsContent>)}
      </Tabs>
    </div>
  );
}

export type { Person };
