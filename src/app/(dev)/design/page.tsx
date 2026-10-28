"use client";
import * as React from "react";
import { CalendarPlus, Download, Inbox, LogIn, MoreHorizontal, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { AppShell, PageHeader } from "@/ui/app-shell";
import { Button, IconButton } from "@/ui/button";
import { Field, Input, MoneyInput, Textarea, formatINR } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, RadioGroup, Segmented, Switch } from "@/ui/choice";
import { Badge, StatusChip } from "@/ui/badge";
import { Avatar, AvatarGroup } from "@/ui/avatar";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { ConfirmDialog, Drawer, Menu, Modal, Popover, Tooltip } from "@/ui/overlay";
import { DataTable, type Column } from "@/ui/table";
import { BalanceRing, Banner, EmptyState, Progress, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline, Stepper } from "@/ui/flow";
import { Calendar, type Range } from "@/ui/calendar";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";

const PEOPLE: Person[] = [
  { id: "e1", name: "Asha Verma", title: "HR Manager", department: "People" },
  { id: "e2", name: "Rohan Mehta", title: "Engineering Lead", department: "Engineering" },
  { id: "e3", name: "Priya Nair", title: "Product Designer", department: "Design" },
  { id: "e4", name: "Karan Singh", title: "Payroll Specialist", department: "Finance" },
  { id: "e5", name: "Meera Iyer", title: "Recruiter", department: "People" },
  { id: "e6", name: "Arjun Rao", title: "Backend Engineer", department: "Engineering" },
];

type Req = { id: string; name: string; type: string; dates: string; days: number; status: "pending" | "approved" | "rejected" };
const REQS: Req[] = [
  { id: "LR-1042", name: "Rohan Mehta", type: "Casual leave", dates: "3–4 Nov", days: 2, status: "pending" },
  { id: "LR-1041", name: "Priya Nair", type: "Sick leave", dates: "29 Oct", days: 0.5, status: "approved" },
  { id: "LR-1038", name: "Arjun Rao", type: "Earned leave", dates: "10–14 Nov", days: 5, status: "pending" },
  { id: "LR-1031", name: "Meera Iyer", type: "Comp off", dates: "27 Oct", days: 1, status: "rejected" },
];

const COLS: Column<Req>[] = [
  { key: "name", header: "Employee", sortValue: (r) => r.name, cell: (r) => <span className="flex items-center gap-2.5"><Avatar name={r.name} size="sm" /><span className="font-medium">{r.name}</span></span> },
  { key: "type", header: "Leave type", cell: (r) => r.type, hideBelow: "md" },
  { key: "dates", header: "Dates", cell: (r) => r.dates },
  { key: "days", header: "Days", align: "right", sortValue: (r) => r.days, cell: (r) => r.days },
  { key: "status", header: "Status", cell: (r) => <StatusChip status={r.status} /> },
  { key: "act", header: <span className="sr-only">Actions</span>, width: "48px", cell: (r) => (
    <span onClick={(e) => e.stopPropagation()}>
      <Menu trigger={<IconButton label={`Actions for ${r.id}`} size="icon-sm"><MoreHorizontal /></IconButton>}
        items={[{ label: "View", icon: <Search /> }, { label: "Edit", icon: <Pencil /> }, "separator", { label: "Cancel request", icon: <Trash2 />, danger: true }]} />
    </span>
  ) },
];

function Section({ id, title, children, note }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-20">
      <div className="mb-3 flex items-baseline gap-3"><h2 id={id} className="text-lg font-semibold">{title}</h2>{note && <p className="text-sm text-text-muted">{note}</p>}</div>
      {children}
    </section>
  );
}

const SWATCHES = ["canvas", "surface", "surface-sunken", "surface-hover", "border", "border-strong", "border-input", "text", "text-muted", "accent", "accent-soft", "success", "success-soft", "warning", "warning-soft", "danger", "danger-soft"];

function ClockCard() {
  const [inAt, setInAt] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(0);
  React.useEffect(() => { if (!inAt) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [inAt]);
  const secs = inAt ? Math.max(0, Math.floor((now - inAt) / 1000)) : 0;
  const hms = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60].map((n) => String(n).padStart(2, "0")).join(":");
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-text-muted">General shift · 09:30 – 18:30</p>
          <p className="mt-1 text-2xl font-semibold tabular" aria-live="off">{inAt ? hms : "--:--:--"}</p>
          <p className="text-sm text-text-muted">{inAt ? "Since clock-in" : "Not clocked in yet"}</p>
        </div>
        <Badge tone={inAt ? "success" : "neutral"}>{inAt ? "Working" : "Off"}</Badge>
      </div>
      <div className="mt-4 flex gap-2">
        <Button block variant={inAt ? "secondary" : "primary"} onClick={() => {
          if (inAt) { setInAt(null); toast.success("Clocked out", { description: `Worked ${hms} today` }); }
          else { const t = Date.now(); setInAt(t); setNow(t); toast.success("Clocked in at " + new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })); }
        }}>
          <LogIn />{inAt ? "Clock out" : "Clock in"}
        </Button>
        <Menu trigger={<IconButton variant="secondary" label="More attendance options"><MoreHorizontal /></IconButton>}
          items={[{ label: "Work from home" }, { label: "On duty" }, { label: "Partial day" }]} />
      </div>
    </Card>
  );
}

export default function DesignPage() {
  const [range, setRange] = React.useState<Range>({ from: null, to: null });
  const [half, setHalf] = React.useState<"full" | "first" | "second">("full");
  const [people, setPeople] = React.useState<string[]>(["e2"]);
  const [manager, setManager] = React.useState<string[]>([]);
  const [paise, setPaise] = React.useState<number | null>(4500000);
  const [step, setStep] = React.useState(1);
  const [loading, setLoading] = React.useState(false);
  const marks = { "2026-11-01": "weekly_off", "2026-11-08": "weekly_off", "2026-11-14": "weekly_off", "2026-11-15": "weekly_off", "2026-11-09": "holiday", "2026-11-20": "leave" } as const;

  return (
    <AppShell>
      <PageHeader title="Design system" description="Every erp primitive, in every state. Tokens: replica/design/tokens.json."
        breadcrumb="Internal" actions={<><Button variant="secondary"><Download />Export</Button><Button><Plus />New request</Button></>} />

      <div className="flex flex-col gap-12">
        <Section id="colors" title="Colour roles" note="Values change in /replica-brand; roles never do">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {SWATCHES.map((s) => (
              <div key={s} className="overflow-hidden rounded-md border border-border bg-surface">
                <div className="h-12" style={{ background: `var(--${s})` }} />
                <p className="px-2 py-1.5 text-xs font-medium">{s}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Chart palette">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <span key={i} className="flex items-center gap-1.5 rounded-pill border border-border bg-surface px-2 py-1 text-xs"><span className="size-3 rounded-pill" style={{ background: `var(--chart-${i})` }} />Series {i}</span>)}
          </div>
        </Section>

        <Section id="type" title="Type">
          <Card className="divide-y divide-border">
            {([["display", "text-display"], ["2xl", "text-2xl"], ["xl", "text-xl"], ["lg", "text-lg"], ["md", "text-md"], ["base", "text-base"], ["sm", "text-sm"], ["xs", "text-xs"]] as const).map(([t, cls]) => (
              <div key={t} className="flex items-baseline gap-6 px-5 py-3">
                <span className="w-16 shrink-0 text-xs text-text-muted">{t}</span>
                <span className={`${cls} truncate`}>Leave approved for 3 days · ₹1,25,000</span>
              </div>
            ))}
          </Card>
        </Section>

        <Section id="buttons" title="Buttons">
          <Card className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Button>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="soft">Soft</Button>
              <Button variant="ghost">Ghost</Button><Button variant="danger">Reject</Button><Button variant="link">Link</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm">Small</Button><Button>Medium</Button><Button size="lg">Large</Button>
              <Button disabled>Disabled</Button>
              <Button loading={loading} onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1500); }}>Approve</Button>
              <Tooltip content="Add people"><IconButton label="Add people" variant="secondary"><Users /></IconButton></Tooltip>
            </div>
          </Card>
        </Section>

        <Section id="forms" title="Form controls">
          <Card className="grid gap-5 p-5 md:grid-cols-2">
            <Field label="Full name" required help="As on PAN card"><Input placeholder="e.g. Asha Verma" /></Field>
            <Field label="Work email" required error="This email is already used by another employee"><Input type="email" defaultValue="rohan@acme.in" /></Field>
            <Field label="Search"><Input leading={<Search />} placeholder="Search employees" /></Field>
            <Field label="Annual CTC" help={paise != null ? `Monthly ≈ ${formatINR(Math.round(paise / 12))}` : undefined}><MoneyInput valuePaise={paise} onChangePaise={setPaise} /></Field>
            <Field label="Department"><Select placeholder="Choose department" options={[{ value: "eng", label: "Engineering" }, { value: "people", label: "People" }, { value: "fin", label: "Finance" }, { value: "x", label: "Legal (archived)", disabled: true }]} /></Field>
            <Field label="Reporting manager"><EmployeePicker people={PEOPLE} value={manager} onChange={setManager} placeholder="Choose a manager" /></Field>
            <Field label="Notify" help="They get an email; they don't need to approve" className="md:col-span-2"><EmployeePicker multiple people={PEOPLE} value={people} onChange={setPeople} /></Field>
            <Field label="Reason" className="md:col-span-2"><Textarea placeholder="Optional note for your manager" /></Field>
            <Field label="Read only"><Input readOnly defaultValue="EMP-0042" /></Field>
            <Field label="Disabled"><Input disabled defaultValue="Locked after payroll" /></Field>
            <div className="flex flex-col gap-3">
              <Checkbox label="Send invite email now" defaultChecked />
              <Checkbox label="Disabled option" disabled />
              <Switch label="Allow web clock-in" defaultChecked />
            </div>
            <div className="flex flex-col gap-3">
              <RadioGroup defaultValue="new" options={[{ value: "new", label: "New tax regime", hint: "Lower rates, fewer deductions" }, { value: "old", label: "Old tax regime", hint: "Claim 80C, 80D, HRA" }]} />
              <Segmented label="Day part" value={half} onChange={setHalf} options={[{ value: "full", label: "Full day" }, { value: "first", label: "First half" }, { value: "second", label: "Second half" }]} />
            </div>
          </Card>
        </Section>

        <Section id="status" title="Badges, status, avatars">
          <Card className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap gap-2">
              <StatusChip status="pending" /><StatusChip status="approved" /><StatusChip status="rejected" /><StatusChip status="cancelled" /><StatusChip status="draft" /><StatusChip status="live" /><StatusChip status="overdue" />
              <Badge tone="accent">In probation</Badge><Badge>Contract</Badge><Badge tone="success" size="md">Payroll finalized</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Avatar name="Asha Verma" size="xs" /><Avatar name="Rohan Mehta" size="sm" status="online" /><Avatar name="Priya Nair" size="md" status="leave" /><Avatar name="Karan Singh" size="lg" status="remote" /><Avatar name="Meera Iyer" size="xl" />
              <AvatarGroup names={PEOPLE.map((p) => p.name)} />
            </div>
          </Card>
        </Section>

        <Section id="cards" title="Cards, stats, balances">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <StatTile label="Headcount" value="248" delta={{ value: "+6", good: true, up: true }} hint="this month" icon={<Users />} />
            <StatTile label="On leave today" value="12" hint="4.8% of team" />
            <StatTile label="Attrition (12 mo)" value="9.4%" delta={{ value: "+1.2 pts", good: false, up: true }} />
            <StatTile label="October net pay" value={formatINR(1_86_45_230_00, { decimals: 0 })} hint="finalized 28 Oct" />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <ClockCard />
            <Card className="lg:col-span-2">
              <CardHeader title="Leave balance" description="Leave year Jan–Dec 2026" action={<Button size="sm"><CalendarPlus />Apply leave</Button>} />
              <CardBody className="flex flex-wrap justify-around gap-6">
                <BalanceRing label="Casual" available={4} total={12} color="var(--chart-1)" />
                <BalanceRing label="Sick" available={6.5} total={8} color="var(--chart-3)" />
                <BalanceRing label="Earned" available={11} total={18} color="var(--chart-7)" />
                <BalanceRing label="Comp off" available={1} total={2} color="var(--chart-2)" />
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section id="table" title="Table" note="Sort, select, bulk bar, row menu, loading, empty">
          <Tabs defaultValue="all">
            <TabsList items={[{ value: "all", label: "All", count: 4 }, { value: "loading", label: "Loading" }, { value: "empty", label: "Empty" }]} />
            <TabsContent value="all">
              <DataTable caption="Leave requests" rows={REQS} columns={COLS} rowKey={(r) => r.id} selectable onRowClick={(r) => toast(`Open ${r.id}`)}
                bulkActions={(ids, clear) => <><Button size="sm" variant="secondary" onClick={clear}>Clear</Button><Button size="sm" onClick={() => { toast.success(`Approved ${ids.length} requests`, { action: { label: "Undo", onClick: () => toast("Undone") } }); clear(); }}>Approve</Button></>} />
            </TabsContent>
            <TabsContent value="loading"><DataTable caption="Loading" rows={[]} columns={COLS} rowKey={(r) => r.id} loading /></TabsContent>
            <TabsContent value="empty">
              <DataTable caption="Empty" rows={[]} columns={COLS} rowKey={(r) => r.id}
                empty={<EmptyState icon={<Inbox />} title="No pending requests" description="When your team applies for leave, it shows up here for you to approve." />} />
            </TabsContent>
          </Tabs>
        </Section>

        <Section id="overlays" title="Overlays & toasts">
          <Card className="flex flex-wrap gap-2 p-5">
            <Modal size="md" title="Apply leave" description="Casual leave · 4 days available" trigger={<Button variant="secondary">Modal</Button>}
              footer={<><Button variant="secondary">Cancel</Button><Button>Request</Button></>}>
              <div className="flex flex-col gap-4">
                <Field label="Leave type"><Select defaultValue="cl" options={[{ value: "cl", label: "Casual leave" }, { value: "sl", label: "Sick leave" }]} /></Field>
                <Field label="Note"><Textarea /></Field>
              </div>
            </Modal>
            <Drawer title="LR-1042 · Rohan Mehta" description="Casual leave · 3–4 Nov · 2 days" trigger={<Button variant="secondary">Drawer</Button>}
              footer={<><Button variant="danger">Reject</Button><Button>Approve</Button></>}>
              <ApprovalTimeline levels={[{ level: 1, approver: "Asha Verma", role: "Manager", status: "approved", at: "28 Oct, 10:12", comment: "Enjoy the break!" }, { level: 2, approver: "Karan Singh", role: "HR", status: "pending" }]} />
            </Drawer>
            <ConfirmDialog title="Finalize October payroll?" description="Payslips can be released after this, and attendance for October gets locked. Changes after this go to November as arrears."
              confirmLabel="Finalize" tone="primary" onConfirm={() => new Promise((r) => setTimeout(r, 900))} trigger={<Button variant="secondary">Confirm dialog</Button>} />
            <Popover trigger={<Button variant="secondary">Popover</Button>}><p className="max-w-56 text-base">Sandwich rule: the weekend between two leave days also counts as leave.</p></Popover>
            <Button variant="secondary" onClick={() => toast.success("Leave requested", { description: "Asha Verma will review it" })}>Success toast</Button>
            <Button variant="secondary" onClick={() => toast.error("Couldn't clock in", { description: "You're outside the office geofence (420 m away)" })}>Error toast</Button>
          </Card>
        </Section>

        <Section id="date" title="Calendar & leave">
          <Card className="grid gap-6 p-5 md:grid-cols-[auto_1fr]">
            <Calendar range={range} onRangeChange={setRange} marks={marks} month={new Date(2026, 10, 1)} />
            <div className="flex flex-col gap-3">
              <p className="text-base"><span className="text-text-muted">Selected: </span>{range.from ? range.from.toDateString() : "—"}{range.to ? ` → ${range.to.toDateString()}` : ""}</p>
              <Banner tone="info" title="Sandwich rule applies">Saturday and Sunday between your leave days count as leave. Total: 4 days.</Banner>
              <Banner tone="warning">You&apos;ll have 0 casual leave left after this request.</Banner>
            </div>
          </Card>
        </Section>

        <Section id="flow" title="Steppers & timelines">
          <Card className="flex flex-col gap-6 p-5">
            <Stepper steps={["Basic details", "Job", "Work policies", "Compensation"]} current={step} onStepClick={setStep} />
            <div className="flex gap-2"><Button variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</Button><Button onClick={() => setStep((s) => Math.min(3, s + 1))}>Continue</Button></div>
            <ApprovalTimeline levels={[
              { level: 1, approver: "Rohan Mehta", role: "Manager", status: "approved", at: "Today 09:41" },
              { level: 2, approver: "Asha Verma", role: "HR Manager", status: "pending" },
              { level: 3, approver: "Karan Singh", role: "Finance", status: "waiting" },
            ]} />
          </Card>
        </Section>

        <Section id="feedback" title="Feedback">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Banner tone="success" title="Payroll finalized">October payroll for 248 employees is locked.</Banner>
              <Banner tone="danger" title="3 employees have no bank account" action={<Button size="sm" variant="secondary">Fix</Button>}>They will be skipped in the bank file.</Banner>
            </div>
            <Card className="flex flex-col gap-4 p-5">
              <div className="flex flex-col gap-1.5"><span className="text-sm text-text-muted">Onboarding tasks · 7 of 10</span><Progress value={7} max={10} label="Onboarding progress" tone="success" /></div>
              <div className="flex items-center gap-3"><Skeleton className="size-10 rounded-pill" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-3 w-1/2" /><Skeleton className="h-3 w-1/3" /></div></div>
            </Card>
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
