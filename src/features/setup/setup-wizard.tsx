"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Building2, CalendarDays, CheckCircle2, FileSpreadsheet, Mail, PartyPopper, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody } from "@/ui/card";
import { Segmented } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { Field, Input } from "@/ui/field";
import { Stepper } from "@/ui/flow";
import { Select } from "@/ui/select";
import { toast } from "@/ui/toast";
import { QUOTA_TYPES, SETUP_STEPS, STATES, STEP_KEYS, WEEKLY_OFF_PRESETS, stateName, type SetupStep, type WeeklyOffPreset } from "@/server/modules/setup/rules";
import type { SetupData } from "@/server/modules/setup/service";
import type { MasterRow } from "@/server/modules/settings/org";
import { deleteMasterAction, saveMasterAction } from "@/app/(app)/actions";
import { completeStepAction, deleteSetupHolidayAction, finishSetupAction, inviteEveryoneAction, openSetupAction, saveCompanyAction, saveLeaveBasicsAction, savePoliciesAction, setupHolidayAction } from "@/app/(app)/setup/actions";

type StepProps = { data: SetupData; onDone: () => void };

/** First-run wizard. Each step saves on its own, so leaving half-way and coming back picks up where you were. */
export function SetupWizard({ data, initialStep }: { data: SetupData; initialStep: SetupStep }) {
  const router = useRouter();
  const [index, setIndex] = React.useState(Math.max(0, STEP_KEYS.indexOf(initialStep)));
  const [busy, setBusy] = React.useState(false);
  const step = SETUP_STEPS[index];
  const heading = React.useRef<HTMLHeadingElement>(null);
  const opened = React.useRef(false);

  // the first visit marks setup as started, so the dashboard stops sending people here
  React.useEffect(() => {
    if (opened.current || data.state.status === "started" || data.state.status === "done") return;
    opened.current = true;
    openSetupAction().catch(() => {});
  }, [data.state.status]);

  const goTo = (i: number) => {
    const n = Math.max(0, Math.min(STEP_KEYS.length - 1, i));
    setIndex(n);
    window.history.replaceState(null, "", `/setup?step=${STEP_KEYS[n]}`);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const next = () => goTo(index + 1);
  const skip = async () => {
    setBusy(true);
    const r = await completeStepAction(step.key, "skipped").finally(() => setBusy(false));
    if (!r.ok) return toast.error(r.error);
    if (index === STEP_KEYS.length - 1) return finishNow();
    next();
  };
  const finishNow = async () => {
    setBusy(true);
    const r = await finishSetupAction().finally(() => setBusy(false));
    if (!r.ok) return toast.error(r.error);
    toast.success("Setup finished. Welcome aboard!");
    router.push("/org/dashboard");
  };

  const status = data.state.steps[step.key]?.status;
  const props: StepProps = { data, onDone: index === STEP_KEYS.length - 1 ? finishNow : next };

  return (
    <div className="flex flex-col gap-5">
      {data.state.status === "done" && (
        <Banner tone="success" title="Setup is finished">You can still change anything here, or later in Settings.</Banner>
      )}
      <nav aria-label="Setup steps">
        <Stepper steps={SETUP_STEPS.map((s) => s.label)} current={index} onStepClick={goTo} />
      </nav>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <p className="text-sm text-text-muted">Step {index + 1} of {SETUP_STEPS.length}{status ? ` · ${status === "done" ? "done" : "skipped"}` : ""}</p>
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">{step.label}</h2>
            <p className="text-base text-text-muted">{step.hint}</p>
          </div>
          {status === "done" && <CheckCircle2 className="size-5 text-success-text" aria-label="Step done" />}
        </div>
        <CardBody>
          {step.key === "company" && <CompanyStep {...props} />}
          {step.key === "locations" && <ListStep {...props} kind="locations" rows={data.locations} word="location" placeholder="e.g. Bengaluru office" />}
          {step.key === "departments" && <ListStep {...props} kind="departments" rows={data.departments} word="department" placeholder="e.g. Customer success" />}
          {step.key === "designations" && <ListStep {...props} kind="designations" rows={data.designations} word="designation" placeholder="e.g. Product manager" />}
          {step.key === "business_units" && <ListStep {...props} kind="business_units" rows={data.businessUnits} word="business unit" placeholder="e.g. Consumer products" optional />}
          {step.key === "leave" && <LeaveStep {...props} />}
          {step.key === "policies" && <PoliciesStep {...props} />}
          {step.key === "people" && <PeopleStep {...props} />}
          {step.key === "invite" && <InviteStep {...props} />}
        </CardBody>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => goTo(index - 1)} disabled={index === 0 || busy}><ArrowLeft />Back</Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" asChild><Link href="/org/dashboard">Finish later</Link></Button>
          <Button variant="secondary" onClick={skip} loading={busy}>{index === STEP_KEYS.length - 1 ? "Skip and finish" : "Skip for now"}</Button>
        </div>
      </div>
    </div>
  );
}

function CompanyStep({ data, onDone }: StepProps) {
  const c = data.company;
  const [v, setV] = React.useState({ name: c.name, pan: c.pan ?? "", tan: c.tan ?? "", line1: c.address.line1 ?? "", line2: c.address.line2 ?? "", city: c.address.city ?? "", state: c.address.state ?? "", pincode: c.address.pincode ?? "" });
  const [err, setErr] = React.useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = React.useTransition();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const fe = (f: string) => (err?.field === f ? err.message : undefined);
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await saveCompanyAction(v);
        if (!r.ok) { setErr({ field: "field" in r ? r.field : undefined, message: r.error }); return; }
        setErr(null); toast.success("Company details saved"); onDone();
      });
    }}>
      {err && !err.field && <Banner tone="danger">{err.message}</Banner>}
      <Field label="Registered company name" required error={fe("name")} help="As it appears on your incorporation certificate. Used on payslips and letters.">
        <Input value={v.name} onChange={set("name")} autoComplete="organization" required maxLength={160} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="PAN" error={fe("pan")} help="Optional. 10 characters, e.g. ABCDE1234F"><Input value={v.pan} onChange={set("pan")} maxLength={10} className="uppercase" autoCapitalize="characters" /></Field>
        <Field label="TAN" error={fe("tan")} help="Optional. Needed later for TDS filings"><Input value={v.tan} onChange={set("tan")} maxLength={10} className="uppercase" autoCapitalize="characters" /></Field>
      </div>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-base font-semibold">Registered address <span className="font-normal text-text-muted">(optional)</span></legend>
        <Field label="Address line 1"><Input value={v.line1} onChange={set("line1")} autoComplete="address-line1" maxLength={200} /></Field>
        <Field label="Address line 2"><Input value={v.line2} onChange={set("line2")} autoComplete="address-line2" maxLength={200} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City"><Input value={v.city} onChange={set("city")} autoComplete="address-level2" maxLength={80} /></Field>
          <Field label="State" error={fe("state")}>
            <Select value={v.state || undefined} onValueChange={(s) => setV((x) => ({ ...x, state: s }))} placeholder="Choose a state" options={STATES.map((s) => ({ value: s.code, label: s.name }))} />
          </Field>
          <Field label="PIN code" error={fe("pincode")}><Input value={v.pincode} onChange={set("pincode")} inputMode="numeric" autoComplete="postal-code" maxLength={6} /></Field>
        </div>
      </fieldset>
      <div className="flex justify-end"><Button type="submit" loading={pending}>Save and continue</Button></div>
    </form>
  );
}

function ListStep({ onDone, kind, rows, word, placeholder, optional }: StepProps & { kind: "locations" | "departments" | "designations" | "business_units"; rows: MasterRow[]; word: string; placeholder: string; optional?: boolean }) {
  const [name, setName] = React.useState("");
  const [stateCode, setStateCode] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [adding, startAdd] = React.useTransition();
  const [continuing, startContinue] = React.useTransition();
  const [removing, setRemoving] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const isLoc = kind === "locations";
  const stateOptions = STATES.map((s) => ({ value: s.code, label: s.name }));

  const add = () => startAdd(async () => {
    if (!name.trim()) { setErr(`Type a ${word} name first.`); input.current?.focus(); return; }
    const r = await saveMasterAction(kind, null, { name, stateCode: isLoc ? stateCode || null : undefined });
    if (!r.ok) { setErr(r.error); return; }
    setErr(null); setName(""); setStateCode(""); input.current?.focus();
    toast.success(`Added ${name.trim()}`);
  });
  const remove = async (row: MasterRow) => {
    setRemoving(row.id);
    const r = await deleteMasterAction(kind, row.id).finally(() => setRemoving(null));
    if (!r.ok) toast.error(r.error); else toast.success(`Removed ${row.name}`);
  };
  const setRowState = async (row: MasterRow, code: string) => {
    const r = await saveMasterAction(kind, row.id, { name: row.name, stateCode: code });
    if (!r.ok) toast.error(r.error); else toast.success(`${row.name}: ${stateName(code)}`);
  };

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <EmptyState compact icon={<Building2 />} title={`No ${kind} yet`} description={`Add your first ${word} below.`} />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" aria-label={`Your ${kind}`}>
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{r.name}</p>
                <p className="text-sm text-text-muted">{r.people} {r.people === 1 ? "person" : "people"}</p>
              </div>
              {isLoc && (
                <div className="w-full sm:w-52">
                  <Select size="sm" value={r.state_code ?? undefined} placeholder="Choose a state" options={stateOptions} onValueChange={(c) => setRowState(r, c)} />
                </div>
              )}
              <IconButton label={r.people ? `${r.name} has people, move them first` : `Remove ${r.name}`} size="icon-sm" variant="ghost"
                disabled={r.people > 0 || removing === r.id} onClick={() => remove(r)}><Trash2 /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <form className="flex flex-col gap-3 sm:flex-row sm:items-end" noValidate onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Field label={`New ${word}`} error={err ?? undefined} className="flex-1">
          <Input ref={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} maxLength={120} />
        </Field>
        {isLoc && (
          <Field label="State" className="sm:w-52">
            <Select value={stateCode || undefined} onValueChange={setStateCode} placeholder="Choose a state" options={stateOptions} />
          </Field>
        )}
        <Button type="submit" variant="secondary" loading={adding}><Plus />Add</Button>
      </form>
      {isLoc && <p className="text-sm text-text-muted">The state decides professional tax and labour welfare fund rules when you run payroll.</p>}
      {kind === "business_units" && <p className="text-sm text-text-muted">Business units group departments across legal entities, and roles can be limited to one. Skip this if your company is one unit.</p>}
      <div className="flex justify-end">
        <Button loading={continuing} onClick={() => startContinue(async () => {
          const r = await completeStepAction(kind, optional && rows.length === 0 ? "skipped" : "done");
          if (!r.ok) { toast.error(r.error); return; }
          onDone();
        })}>Continue</Button>
      </div>
    </div>
  );
}

function LeaveStep({ data, onDone }: StepProps) {
  const l = data.leave;
  const [yearStart, setYearStart] = React.useState<"jan" | "apr">(l.yearStart);
  const [quotas, setQuotas] = React.useState<Record<string, string>>(Object.fromEntries(QUOTA_TYPES.map((t) => [t.code, l.quotas[t.code] == null ? "" : String(l.quotas[t.code])])));
  const [err, setErr] = React.useState<{ field?: string; message: string } | null>(null);
  const [pending, start] = React.useTransition();
  if (!l.planId) return <EmptyState compact title="No leave plan found" description="You can set leave up later in Settings." />;
  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await saveLeaveBasicsAction({ yearStart, quotas });
        if (!r.ok) { setErr({ field: "field" in r ? r.field : undefined, message: r.error }); return; }
        setErr(null);
        const n = r.data?.resynced ?? 0;
        toast.success(n ? `Leave basics saved. Balances updated for ${n} ${n === 1 ? "person" : "people"}.` : "Leave basics saved");
        onDone();
      });
    }}>
      {err && !QUOTA_TYPES.some((t) => t.code === err.field) && <Banner tone="danger">{err.message}</Banner>}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium" id="year-start-label">Leave year starts in</p>
        {l.locked ? (
          <p className="text-base">{yearStart === "apr" ? "April" : "January"} <span className="text-sm text-text-muted">· can&apos;t change now that people have requested leave</span></p>
        ) : (
          <Segmented label="Leave year starts in" value={yearStart} onChange={setYearStart} options={[{ value: "jan", label: "January" }, { value: "apr", label: "April" }]} />
        )}
        <p className="text-sm text-text-muted">Balances reset and carry forward at the start of each leave year.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {QUOTA_TYPES.map((t) => (
          <Field key={t.code} label={`${t.name} (days a year)`} error={err?.field === t.code ? err.message : undefined}>
            <Input type="number" inputMode="decimal" min={0} max={60} step={0.5} value={quotas[t.code]} onChange={(e) => setQuotas((q) => ({ ...q, [t.code]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <p className="text-sm text-text-muted">People who join during the year get a share for the months left. Detailed rules (accrual, carry forward, sandwich) live in leave settings.</p>
      <div className="flex justify-end"><Button type="submit" loading={pending}>Save and continue</Button></div>
    </form>
  );
}

/** Holidays for this year, the default shift's hours, the weekly-off pattern, and (with payroll) the attendance cut-off day. */
function PoliciesStep({ data, onDone }: StepProps) {
  const p = data.policies;
  const [shiftStart, setShiftStart] = React.useState(p.shift?.start ?? "09:30");
  const [shiftEnd, setShiftEnd] = React.useState(p.shift?.end ?? "18:30");
  const [weeklyOff, setWeeklyOff] = React.useState<WeeklyOffPreset>(p.weeklyOff?.preset ?? "sat_sun");
  const [cutoff, setCutoff] = React.useState(p.payGroup ? String(p.payGroup.cutoffDay) : "");
  const [holiday, setHoliday] = React.useState({ name: "", date: "" });
  const [err, setErr] = React.useState<{ field?: string; message: string } | null>(null);
  const [hErr, setHErr] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const [adding, startAdd] = React.useTransition();
  const fe = (f: string) => (err?.field === f ? err.message : undefined);
  const year = new Date().getFullYear();
  const addHoliday = () => startAdd(async () => {
    setHErr(null);
    const r = await setupHolidayAction({ name: holiday.name, date: holiday.date });
    if (!r.ok) { setHErr(r.error); return; }
    toast.success(`Added ${holiday.name.trim()}`); setHoliday({ name: "", date: "" });
  });
  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await savePoliciesAction({ shiftStart, shiftEnd, weeklyOff, cutoffDay: cutoff || null });
        if (!r.ok) { setErr({ field: "field" in r ? r.field : undefined, message: r.error }); return; }
        setErr(null); toast.success("Policies saved"); onDone();
      });
    }}>
      {err && !err.field && <Banner tone="danger">{err.message}</Banner>}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Holidays {p.holidayList ? `· ${p.holidayList.name} ${p.holidayList.year}` : `· ${year}`}</h3>
        {!p.holidayList || p.holidayList.holidays.length === 0 ? (
          <EmptyState compact icon={<CalendarDays />} title="No holidays yet" description="Add the public holidays your offices close for. You can keep a list per location later in Settings → Holidays." />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" aria-label="Holidays">
            {p.holidayList.holidays.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-28 shrink-0 text-sm tabular text-text-muted">{new Date(h.date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" })}</span>
                <span className="min-w-0 flex-1 truncate text-base">{h.name}{h.is_floater ? " (optional)" : ""}</span>
                <IconButton label={`Remove ${h.name}`} size="icon-sm" variant="ghost" onClick={async () => { const r = await deleteSetupHolidayAction(h.id); if (!r.ok) toast.error(r.error); }}><Trash2 /></IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Holiday" className="flex-1" error={hErr ?? undefined}><Input value={holiday.name} onChange={(e) => setHoliday({ ...holiday, name: e.target.value })} placeholder="e.g. Republic Day" maxLength={80} /></Field>
          <Field label="Date" className="sm:w-44"><Input type="date" value={holiday.date} onChange={(e) => setHoliday({ ...holiday, date: e.target.value })} /></Field>
          <Button type="button" variant="secondary" loading={adding} onClick={addHoliday} disabled={!holiday.name.trim() || !holiday.date}><Plus />Add</Button>
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Default shift {p.shift ? `· ${p.shift.name}` : ""}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" required error={fe("shiftStart")}><Input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} /></Field>
          <Field label="Ends" required error={fe("shiftEnd")}><Input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} /></Field>
        </div>
        <p className="text-sm text-text-muted">Applies Monday to Friday for everyone who has no other shift. Breaks, grace time and more shifts live in Settings → Time.</p>
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Weekly off</h3>
        <Field label="Days off every week" error={fe("weeklyOff")}>
          <Select value={weeklyOff} onValueChange={(v) => setWeeklyOff(v as WeeklyOffPreset)} options={WEEKLY_OFF_PRESETS.map((w) => ({ value: w.key, label: w.label }))} />
        </Field>
      </section>
      {p.payGroup && (
        <section className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">Pay cycle · {p.payGroup.name}</h3>
          <Field label="Attendance cut-off day" help="Attendance up to this day of the month goes into that month's salary." error={fe("cutoffDay")} className="sm:w-56">
            <Input type="number" inputMode="numeric" min={1} max={31} value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
          </Field>
        </section>
      )}
      <div className="flex justify-end"><Button type="submit" loading={pending}>Save and continue</Button></div>
    </form>
  );
}

function PeopleStep({ data, onDone }: StepProps) {
  const [pending, start] = React.useTransition();
  const n = data.people.total;
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-base"><Users className="size-4 text-text-muted" aria-hidden />
        {n <= 1 ? "Right now it's just you." : `${n} people are in erp so far.`}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/org/employees/new" className="group flex items-start gap-3 rounded-lg border border-border p-4 hover:border-accent hover:bg-surface-sunken">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text" aria-hidden><UserPlus className="size-4" /></span>
          <span><span className="block text-base font-semibold">Add one person</span><span className="block text-sm text-text-muted">Fill in a short form. Good for a handful of people.</span></span>
        </Link>
        <Link href="/org/employees/import" className="group flex items-start gap-3 rounded-lg border border-border p-4 hover:border-accent hover:bg-surface-sunken">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text" aria-hidden><FileSpreadsheet className="size-4" /></span>
          <span><span className="block text-base font-semibold">Import a spreadsheet</span><span className="block text-sm text-text-muted">Download our Excel template, fill it in and upload it.</span></span>
        </Link>
      </div>
      <p className="text-sm text-text-muted">When you&apos;re done adding people, come back to <Link href="/setup?step=people" className="font-medium text-accent-text hover:underline">this step</Link> to continue.</p>
      <div className="flex justify-end">
        <Button loading={pending} onClick={() => start(async () => { const r = await completeStepAction("people", "done"); if (!r.ok) { toast.error(r.error); return; } onDone(); })}>Continue</Button>
      </div>
    </div>
  );
}

function InviteStep({ data, onDone }: StepProps) {
  const [sending, startSend] = React.useTransition();
  const [finishing, startFinish] = React.useTransition();
  const list = data.people.notInvited;
  return (
    <div className="flex flex-col gap-4">
      {list.length === 0 ? (
        <EmptyState compact icon={<PartyPopper />} title="Nobody is waiting for an invite"
          description={data.people.waiting ? `${data.people.waiting} ${data.people.waiting === 1 ? "person has" : "people have"} been invited and haven't set a password yet.` : "Everyone you've added can already sign in."} />
      ) : (
        <>
          <p className="text-base">These people haven&apos;t been invited yet. Each gets an email with a link to set their password (valid for 7 days).</p>
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="Not invited yet">
            {list.map((p) => (
              <li key={p.id} className="px-3 py-2"><p className="truncate text-base font-medium">{p.name}</p><p className="truncate text-sm text-text-muted">{p.email}</p></li>
            ))}
          </ul>
          <div>
            <Button variant="secondary" loading={sending} onClick={() => startSend(async () => {
              const r = await inviteEveryoneAction();
              if (!r.ok) { toast.error(r.error); return; }
              const sent = r.data?.sent ?? 0;
              toast.success(sent ? `Sent ${sent} ${sent === 1 ? "invite" : "invites"}` : "No invites needed");
            })}><Mail />Send {list.length} {list.length === 1 ? "invite" : "invites"}</Button>
          </div>
        </>
      )}
      <div className="flex justify-end">
        <Button loading={finishing} onClick={() => startFinish(async () => {
          const r = await completeStepAction("invite", list.length ? "skipped" : "done");
          if (!r.ok) { toast.error(r.error); return; }
          onDone();
        })}>Finish setup</Button>
      </div>
    </div>
  );
}
