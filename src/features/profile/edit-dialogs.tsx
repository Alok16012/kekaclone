"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select, type Option } from "@/ui/select";
import { Banner } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { changeJobAction, setProbationAction, updateProfileSectionAction } from "@/app/(app)/actions";
import type { Profile } from "@/server/modules/employees/profile";

type Emp = Profile["employee"];
type Lookups = { departments: { id: string; name: string }[]; designations: { id: string; name: string }[]; locations: { id: string; name: string }[]; bands: { id: string; name: string }[]; people: Person[] };
const opts = (xs: { id: string; name: string }[]): Option[] => xs.map((x) => ({ value: x.id, label: x.name }));
const n = (v: string) => (v.trim() === "" ? null : v.trim());

function useSave(close: () => void) {
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, success: (d: unknown) => string) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) { setError(r.error ?? "Couldn't save."); return; }
      toast.success(success(r.data));
      close();
    });
  return { pending, error, run };
}

const sentForApproval = (d: unknown) => ((d as { applied?: boolean })?.applied ? "Saved" : "Sent to HR for approval");

export function EditSection({ section, emp, self, trigger }: { section: "personal" | "contact" | "addresses" | "about"; emp: Emp; self: boolean; trigger: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const { pending, error, run } = useSave(() => setOpen(false));
  const [v, setV] = React.useState<Record<string, string>>({});
  const init = React.useCallback(() => {
    const p = emp.personal, c = emp.contact, a = emp.addresses ?? {}, b = emp.bio ?? {};
    const addr = (k: "current" | "permanent") => Object.fromEntries(["line1", "line2", "city", "state", "pincode", "country"].map((f) => [`${k}.${f}`, (a[k]?.[f] as string) ?? ""]));
    setV({
      dob: p?.dob ?? "", gender: p?.gender ?? "", marital_status: p?.marital_status ?? "", blood_group: p?.blood_group ?? "", nationality: p?.nationality ?? "",
      personal_email: c?.personal_email ?? "", mobile: c?.mobile ?? "",
      ...addr("current"), ...addr("permanent"),
      summary: b.summary ?? "", loveAboutJob: b.loveAboutJob ?? "", hobbies: b.hobbies ?? "",
    });
  }, [emp]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const sel = (k: string) => (x: string) => setV((s) => ({ ...s, [k]: x }));
  const titles = { personal: "Personal details", contact: "Contact details", addresses: "Addresses", about: "About" };
  const payload = () => {
    if (section === "personal") return { dob: n(v.dob), gender: n(v.gender), marital_status: n(v.marital_status), blood_group: n(v.blood_group), nationality: n(v.nationality)?.toUpperCase() ?? null };
    if (section === "contact") return { personal_email: n(v.personal_email), mobile: n(v.mobile) };
    if (section === "addresses") {
      const addr = (k: string) => Object.fromEntries(["line1", "line2", "city", "state", "pincode", "country"].map((f) => [f, n(v[`${k}.${f}`] ?? "")]));
      return { addresses: { current: addr("current"), permanent: addr("permanent") } };
    }
    return { bio: { summary: n(v.summary), loveAboutJob: n(v.loveAboutJob), hobbies: n(v.hobbies) } };
  };
  const needsApproval = self && section !== "about";
  const addressFields = (k: "current" | "permanent", label: string) => (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-semibold">{label}</legend>
      <Field label="Address line 1" className="sm:col-span-2"><Input value={v[`${k}.line1`] ?? ""} onChange={set(`${k}.line1`)} autoComplete="address-line1" /></Field>
      <Field label="Address line 2" className="sm:col-span-2"><Input value={v[`${k}.line2`] ?? ""} onChange={set(`${k}.line2`)} autoComplete="address-line2" /></Field>
      <Field label="City"><Input value={v[`${k}.city`] ?? ""} onChange={set(`${k}.city`)} autoComplete="address-level2" /></Field>
      <Field label="State"><Input value={v[`${k}.state`] ?? ""} onChange={set(`${k}.state`)} autoComplete="address-level1" /></Field>
      <Field label="PIN code"><Input value={v[`${k}.pincode`] ?? ""} onChange={set(`${k}.pincode`)} inputMode="numeric" autoComplete="postal-code" /></Field>
      <Field label="Country"><Input value={v[`${k}.country`] ?? ""} onChange={set(`${k}.country`)} autoComplete="country-name" /></Field>
    </fieldset>
  );
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (o) init(); }} title={`Edit ${titles[section].toLowerCase()}`} size={section === "addresses" ? "lg" : "md"}
      description={needsApproval ? "HR reviews these changes before they show on your profile." : undefined} trigger={trigger}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={() => run(() => updateProfileSectionAction(emp.id, section, payload()), sentForApproval)}>{needsApproval ? "Send for approval" : "Save"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {section === "personal" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date of birth"><Input type="date" value={v.dob ?? ""} onChange={set("dob")} /></Field>
            <Field label="Gender"><Select value={v.gender || undefined} onValueChange={sel("gender")} placeholder="Choose" options={[{ value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "non_binary", label: "Non-binary" }, { value: "undisclosed", label: "Prefer not to say" }]} /></Field>
            <Field label="Marital status"><Select value={v.marital_status || undefined} onValueChange={sel("marital_status")} placeholder="Choose" options={[{ value: "single", label: "Single" }, { value: "married", label: "Married" }, { value: "divorced", label: "Divorced" }, { value: "widowed", label: "Widowed" }, { value: "undisclosed", label: "Prefer not to say" }]} /></Field>
            <Field label="Blood group"><Select value={v.blood_group || undefined} onValueChange={sel("blood_group")} placeholder="Choose" options={["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((b) => ({ value: b, label: b }))} /></Field>
            <Field label="Nationality" help="2-letter code, e.g. IN"><Input value={v.nationality ?? ""} onChange={set("nationality")} maxLength={2} className="uppercase" /></Field>
          </div>
        )}
        {section === "contact" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Personal email"><Input type="email" value={v.personal_email ?? ""} onChange={set("personal_email")} autoComplete="email" /></Field>
            <Field label="Mobile"><Input type="tel" value={v.mobile ?? ""} onChange={set("mobile")} autoComplete="tel" placeholder="+91" /></Field>
          </div>
        )}
        {section === "addresses" && <div className="flex flex-col gap-6">{addressFields("current", "Current address")}{addressFields("permanent", "Permanent address")}</div>}
        {section === "about" && (
          <div className="flex flex-col gap-4">
            <Field label="About me"><Textarea value={v.summary ?? ""} onChange={set("summary")} maxLength={1000} rows={4} /></Field>
            <Field label="What I enjoy about my work"><Textarea value={v.loveAboutJob ?? ""} onChange={set("loveAboutJob")} maxLength={500} /></Field>
            <Field label="Interests and hobbies"><Textarea value={v.hobbies ?? ""} onChange={set("hobbies")} maxLength={500} /></Field>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function JobChangeDialog({ emp, current, lookups, today, trigger }: { emp: Emp; current: { manager_id: string | null }; lookups: Lookups; today: string; trigger: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const { pending, error, run } = useSave(() => setOpen(false));
  const [kind, setKind] = React.useState<"transfer" | "promotion" | "manager_change" | "designation_change" | "other">("transfer");
  const [date, setDate] = React.useState(today);
  const [note, setNote] = React.useState("");
  const [f, setF] = React.useState<Record<string, string | null>>({});
  const reset = () => { setKind("transfer"); setDate(today); setNote(""); setF({ department_id: emp.department_id, designation_id: emp.designation_id, location_id: emp.location_id, manager_id: current.manager_id }); };
  const initial: Record<string, string | null> = { department_id: emp.department_id, designation_id: emp.designation_id, location_id: emp.location_id, manager_id: current.manager_id };
  const changed = Object.fromEntries(Object.entries(f).filter(([k, x]) => x !== initial[k]));
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (o) reset(); }} title="Change job details" description={`${emp.display_name} · changes are recorded on the timeline`} trigger={trigger}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!Object.keys(changed).length} loading={pending}
        onClick={() => run(() => changeJobAction(emp.id, { kind, effectiveDate: date, changes: changed, note: note || undefined }), (d) => ((d as { scheduled?: boolean })?.scheduled ? `Scheduled for ${date}` : "Job details updated"))}>
        {date > today ? "Schedule change" : "Save change"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type of change"><Select value={kind} onValueChange={(x) => setKind(x as typeof kind)} options={[{ value: "transfer", label: "Transfer" }, { value: "promotion", label: "Promotion" }, { value: "manager_change", label: "Manager change" }, { value: "designation_change", label: "Designation change" }, { value: "other", label: "Other" }]} /></Field>
          <Field label="Effective from" help={date > today ? "Applied automatically on this date" : "Applied now"}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Department"><Select value={f.department_id ?? undefined} onValueChange={(x) => setF((s) => ({ ...s, department_id: x }))} options={opts(lookups.departments)} placeholder="Choose" /></Field>
          <Field label="Designation"><Select value={f.designation_id ?? undefined} onValueChange={(x) => setF((s) => ({ ...s, designation_id: x }))} options={opts(lookups.designations)} placeholder="Choose" /></Field>
          <Field label="Location"><Select value={f.location_id ?? undefined} onValueChange={(x) => setF((s) => ({ ...s, location_id: x }))} options={opts(lookups.locations)} placeholder="Choose" /></Field>
          <Field label="Reporting manager"><EmployeePicker people={lookups.people.filter((p) => p.id !== emp.id)} value={f.manager_id ? [f.manager_id] : []} onChange={(ids) => setF((s) => ({ ...s, manager_id: ids[0] ?? null }))} /></Field>
        </div>
        <Field label="Note" help="Visible on the timeline"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

export function ProbationDialog({ emp, today, trigger }: { emp: Emp; today: string; trigger: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const { pending, error, run } = useSave(() => setOpen(false));
  const inProbation = emp.probation_status === "in_probation" || emp.probation_status === "extended";
  const [action, setAction] = React.useState<"confirm" | "extend" | "start">(inProbation ? "confirm" : "start");
  const [date, setDate] = React.useState(today);
  const [note, setNote] = React.useState("");
  const options = inProbation ? [{ value: "confirm", label: "Confirm (end probation)" }, { value: "extend", label: "Extend probation" }] : [{ value: "start", label: "Put on probation" }];
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); if (o) { setAction(inProbation ? "confirm" : "start"); setDate(today); setNote(""); } }} title="Probation" size="sm" trigger={trigger}
      description={inProbation ? `In probation until ${emp.probation_end_date ?? "—"}` : "Not in probation"}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} onClick={() => run(() => setProbationAction(emp.id, { action, date, note: note || undefined }), () => (action === "confirm" ? "Probation confirmed" : "Probation updated"))}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Action"><Select value={action} onValueChange={(x) => setAction(x as typeof action)} options={options} /></Field>
        <Field label={action === "confirm" ? "Confirmation date" : "Probation ends on"}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Feedback"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}
