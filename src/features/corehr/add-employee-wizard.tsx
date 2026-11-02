"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "@/ui/button";
import { Field, Input, MoneyInput } from "@/ui/field";
import { Select, type Option } from "@/ui/select";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Stepper } from "@/ui/flow";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Banner } from "@/ui/feedback";
import { Checkbox } from "@/ui/choice";
import { toast } from "@/ui/toast";
import { addEmployeeAction } from "@/app/(app)/corehr/actions";
import type { FieldValue } from "@/server/modules/corehr/rules";
import { CustomFieldInput, normaliseFieldValues, type FieldSpec } from "./custom-field-input";

type Opt = { id: string; name: string };
export type WizardOptions = {
  departments: Opt[]; designations: Opt[]; locations: Opt[]; people: Person[];
  legalEntities: Opt[]; businessUnits: Opt[]; bands: Opt[]; probation: (Opt & { days: number })[]; notice: (Opt & { days: number })[];
  leavePlans: (Opt & { is_default: boolean })[]; holidayLists: Opt[]; shifts: Opt[]; weeklyOffs: Opt[]; capture: Opt[]; penalties: Opt[]; payGroups: Opt[];
  structures: (Opt & { pay_group_id: string })[]; fields: (FieldSpec & { section: string })[]; canPay: boolean;
};

const STEPS = ["Basic details", "Job", "Work policies", "Compensation"];
const BASIC = new Set(["firstName", "lastName", "middleName", "workEmail", "personalEmail", "mobile", "gender", "dob", "employeeNumber"]);
const JOB = new Set(["joiningDate", "departmentId", "designationId", "locationId", "legalEntityId", "businessUnitId", "bandId", "managerId", "l2ManagerId", "dottedManagerId", "workerType", "timeType", "probationPolicyId", "noticePolicyId"]);
const POLICY = new Set(["leavePlanId", "holidayListId", "shiftId", "weeklyOffId", "capturePolicyId", "penalizationPolicyId", "payGroupId"]);
const opts = (xs: Opt[], none?: string): Option[] => [...(none ? [{ value: "__none", label: none }] : []), ...xs.map((x) => ({ value: x.id, label: x.name }))];

/** Basic → Job → Work policies → Compensation. Everything is saved together at the end, in one transaction. */
export function AddEmployeeWizard({ o, today }: { o: WizardOptions; today: string }) {
  const router = useRouter();
  const [step, setStep] = React.useState(0);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [sendInvite, setSendInvite] = React.useState(true);
  const [v, setV] = React.useState<Record<string, string>>({
    firstName: "", middleName: "", lastName: "", workEmail: "", personalEmail: "", mobile: "", gender: "", dob: "", employeeNumber: "",
    joiningDate: today, departmentId: "", designationId: "", locationId: o.locations[0]?.id ?? "", legalEntityId: o.legalEntities[0]?.id ?? "", businessUnitId: "", bandId: "",
    managerId: "", l2ManagerId: "", dottedManagerId: "", workerType: "permanent", timeType: "full_time", probationPolicyId: "", noticePolicyId: "",
    leavePlanId: o.leavePlans.find((p) => p.is_default)?.id ?? "", holidayListId: "", shiftId: o.shifts[0]?.id ?? "", weeklyOffId: o.weeklyOffs[0]?.id ?? "",
    capturePolicyId: o.capture[0]?.id ?? "", penalizationPolicyId: "", payGroupId: "", structureId: "",
  });
  const [ctc, setCtc] = React.useState<number | null>(null);
  const [custom, setCustom] = React.useState<Record<string, FieldValue>>({});
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const sel = (k: string) => (x: string) => setV((s) => ({ ...s, [k]: x === "__none" ? "" : x }));
  const pick = (k: string) => (ids: string[]) => setV((s) => ({ ...s, [k]: ids[0] ?? "" }));
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  const structures = o.structures.filter((s) => !v.payGroupId || s.pay_group_id === v.payGroupId);
  const sections = [...new Set(o.fields.map((f) => f.section))];

  const check = (i: number): { message: string; field?: string } | null => {
    if (i === 0) {
      if (!v.firstName.trim()) return { message: "Enter a first name.", field: "firstName" };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.workEmail.trim())) return { message: "Enter a valid work email.", field: "workEmail" };
      const missing = o.fields.find((f) => f.required && (custom[f.key] == null || custom[f.key] === "" || (Array.isArray(custom[f.key]) && !(custom[f.key] as string[]).length)));
      if (missing) return { message: `${missing.label} is required.`, field: `custom.${missing.key}` };
    }
    if (i === 1 && !v.joiningDate) return { message: "Pick the joining date.", field: "joiningDate" };
    if (i === 3 && (ctc != null || v.structureId) && !(ctc && v.structureId)) return { message: "Pick a salary structure and enter the annual CTC, or leave both empty.", field: "structureId" };
    return null;
  };
  const next = () => { const e = check(step); setError(e); if (!e) setStep((s) => s + 1); };

  const submit = () => {
    for (let i = 0; i < STEPS.length; i++) { const e = check(i); if (e) { setError(e); setStep(i); return; } }
    const u = (k: string) => v[k] || undefined;
    start(async () => {
      const r = await addEmployeeAction({
        firstName: v.firstName, middleName: u("middleName"), lastName: u("lastName"), workEmail: v.workEmail.trim(), personalEmail: u("personalEmail"), mobile: u("mobile"),
        employeeNumber: u("employeeNumber"), gender: (u("gender") as "male" | undefined), dob: u("dob"), joiningDate: v.joiningDate,
        departmentId: u("departmentId"), designationId: u("designationId"), locationId: u("locationId"), legalEntityId: u("legalEntityId"), businessUnitId: u("businessUnitId"), bandId: u("bandId"),
        managerId: u("managerId"), l2ManagerId: u("l2ManagerId"), dottedManagerId: u("dottedManagerId"), workerType: v.workerType as "permanent", timeType: v.timeType as "full_time",
        probationPolicyId: u("probationPolicyId"), noticePolicyId: u("noticePolicyId"), leavePlanId: u("leavePlanId"), holidayListId: u("holidayListId"), shiftId: u("shiftId"),
        weeklyOffId: u("weeklyOffId"), capturePolicyId: u("capturePolicyId"), penalizationPolicyId: u("penalizationPolicyId"), payGroupId: u("payGroupId"),
        custom: Object.fromEntries(Object.entries(normaliseFieldValues(custom)).filter(([, x]) => x != null)),
        compensation: ctc && v.structureId ? { structureId: v.structureId, ctcPaise: ctc } : null, sendInvite,
      });
      if (!r.ok) {
        const field = "field" in r ? r.field : undefined;
        setError({ message: r.error, field });
        const f = field?.split(".")[0] ?? "";
        setStep(BASIC.has(f) || f === "custom" ? 0 : JOB.has(f) ? 1 : POLICY.has(f) ? 2 : f === "structureId" || f === "ctcPaise" ? 3 : step);
        return;
      }
      toast.success(`${v.firstName} added`, { description: `Employee number ${r.data!.employeeNumber}${r.data!.invited ? " · invite emailed" : ""}` });
      router.push(`/people/${r.data!.employeeId}`);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Stepper steps={STEPS} current={step} onStepClick={setStep} />
      <p className="text-sm text-text-muted sm:hidden" aria-live="polite">Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>
      {error && <Banner tone="danger">{error.message}</Banner>}

      {step === 0 && (
        <>
          <Card>
            <CardHeader title="Basic details" description="Name and how to reach them. The work email becomes their sign-in." />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" required error={err("firstName")}><Input value={v.firstName} onChange={set("firstName")} autoComplete="off" /></Field>
              <Field label="Middle name"><Input value={v.middleName} onChange={set("middleName")} autoComplete="off" /></Field>
              <Field label="Last name" error={err("lastName")}><Input value={v.lastName} onChange={set("lastName")} autoComplete="off" /></Field>
              <Field label="Work email" required error={err("workEmail")}><Input type="email" value={v.workEmail} onChange={set("workEmail")} autoComplete="off" /></Field>
              <Field label="Personal email" error={err("personalEmail")}><Input type="email" value={v.personalEmail} onChange={set("personalEmail")} autoComplete="off" /></Field>
              <Field label="Mobile" error={err("mobile")}><Input type="tel" value={v.mobile} onChange={set("mobile")} placeholder="+91" /></Field>
              <Field label="Gender"><Select value={v.gender || undefined} onValueChange={sel("gender")} options={[{ value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "non_binary", label: "Non-binary" }, { value: "undisclosed", label: "Prefer not to say" }]} placeholder="Choose" /></Field>
              <Field label="Date of birth" error={err("dob")}><Input type="date" value={v.dob} onChange={set("dob")} max={today} /></Field>
              <Field label="Employee number" help="Leave empty to generate one" error={err("employeeNumber")}><Input value={v.employeeNumber} onChange={set("employeeNumber")} /></Field>
            </CardBody>
          </Card>
          {sections.map((s) => (
            <Card key={s}>
              <CardHeader title={s} description="Your company's own fields" />
              <CardBody className="grid gap-4 sm:grid-cols-2">
                {o.fields.filter((f) => f.section === s).map((f) => <CustomFieldInput key={f.key} f={f} value={custom[f.key]} onChange={(x) => setCustom((c) => ({ ...c, [f.key]: x }))} error={err(`custom.${f.key}`)} />)}
              </CardBody>
            </Card>
          ))}
        </>
      )}

      {step === 1 && (
        <Card>
          <CardHeader title="Job" description="Where they sit and who they report to." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Joining date" required error={err("joiningDate")}><Input type="date" value={v.joiningDate} onChange={set("joiningDate")} /></Field>
            <Field label="Legal entity" error={err("legalEntityId")}><Select value={v.legalEntityId || undefined} onValueChange={sel("legalEntityId")} options={opts(o.legalEntities)} /></Field>
            {o.businessUnits.length > 0 && <Field label="Business unit" error={err("businessUnitId")}><Select value={v.businessUnitId || undefined} onValueChange={sel("businessUnitId")} options={opts(o.businessUnits, "None")} placeholder="None" /></Field>}
            <Field label="Department" error={err("departmentId")}><Select value={v.departmentId || undefined} onValueChange={sel("departmentId")} options={opts(o.departments, "None")} placeholder="Choose department" /></Field>
            <Field label="Designation" error={err("designationId")}><Select value={v.designationId || undefined} onValueChange={sel("designationId")} options={opts(o.designations, "None")} placeholder="Choose designation" /></Field>
            <Field label="Location" error={err("locationId")}><Select value={v.locationId || undefined} onValueChange={sel("locationId")} options={opts(o.locations)} /></Field>
            {o.bands.length > 0 && <Field label="Band" error={err("bandId")}><Select value={v.bandId || undefined} onValueChange={sel("bandId")} options={opts(o.bands, "None")} placeholder="None" /></Field>}
            <Field label="Worker type"><Select value={v.workerType} onValueChange={sel("workerType")} options={[{ value: "permanent", label: "Permanent" }, { value: "contract", label: "Contract" }, { value: "intern", label: "Intern" }, { value: "consultant", label: "Consultant" }]} /></Field>
            <Field label="Time type"><Select value={v.timeType} onValueChange={sel("timeType")} options={[{ value: "full_time", label: "Full time" }, { value: "part_time", label: "Part time" }]} /></Field>
            <Field label="Reporting manager" help="Approves their leave and attendance" error={err("managerId")}><EmployeePicker people={o.people} value={v.managerId ? [v.managerId] : []} onChange={pick("managerId")} placeholder="Choose a manager" /></Field>
            <Field label="Second-level manager" error={err("l2ManagerId")}><EmployeePicker people={o.people} value={v.l2ManagerId ? [v.l2ManagerId] : []} onChange={pick("l2ManagerId")} placeholder="Optional" /></Field>
            <Field label="Dotted-line manager" error={err("dottedManagerId")}><EmployeePicker people={o.people} value={v.dottedManagerId ? [v.dottedManagerId] : []} onChange={pick("dottedManagerId")} placeholder="Optional" /></Field>
            <Field label="Probation" error={err("probationPolicyId")}><Select value={v.probationPolicyId || undefined} onValueChange={sel("probationPolicyId")} options={[{ value: "__none", label: "No probation" }, ...o.probation.map((p) => ({ value: p.id, label: `${p.name} (${p.days} days)` }))]} placeholder="No probation" /></Field>
            <Field label="Notice period" error={err("noticePolicyId")}><Select value={v.noticePolicyId || undefined} onValueChange={sel("noticePolicyId")} options={[{ value: "__none", label: "Company default" }, ...o.notice.map((p) => ({ value: p.id, label: `${p.name} (${p.days} days)` }))]} placeholder="Company default" /></Field>
          </CardBody>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader title="Work policies" description="Leave, holidays, shift and attendance rules. Defaults are filled in; change any of them." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label="Leave plan" help="Opening balances are credited straight away" error={err("leavePlanId")}><Select value={v.leavePlanId || undefined} onValueChange={sel("leavePlanId")} options={opts(o.leavePlans)} placeholder="Default plan" /></Field>
            <Field label="Holiday list" help="Empty: the list of their location" error={err("holidayListId")}><Select value={v.holidayListId || undefined} onValueChange={sel("holidayListId")} options={opts(o.holidayLists, "From their location")} placeholder="From their location" /></Field>
            <Field label="Shift" error={err("shiftId")}><Select value={v.shiftId || undefined} onValueChange={sel("shiftId")} options={opts(o.shifts)} /></Field>
            <Field label="Weekly off" error={err("weeklyOffId")}><Select value={v.weeklyOffId || undefined} onValueChange={sel("weeklyOffId")} options={opts(o.weeklyOffs)} /></Field>
            <Field label="Clock-in rules" error={err("capturePolicyId")}><Select value={v.capturePolicyId || undefined} onValueChange={sel("capturePolicyId")} options={opts(o.capture)} /></Field>
            <Field label="Penalty policy" error={err("penalizationPolicyId")}><Select value={v.penalizationPolicyId || undefined} onValueChange={sel("penalizationPolicyId")} options={opts(o.penalties, "No penalties")} placeholder="No penalties" /></Field>
            <Field label="Pay group" error={err("payGroupId")}><Select value={v.payGroupId || undefined} onValueChange={(x) => setV((s) => ({ ...s, payGroupId: x === "__none" ? "" : x, structureId: "" }))} options={opts(o.payGroups, "Not yet")} placeholder="Not yet" /></Field>
          </CardBody>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardHeader title="Compensation" description="Optional. The salary starts on the joining date; payroll can also add it later." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {!o.canPay ? (
              <p className="text-base text-text-muted sm:col-span-2">Only payroll admins set salaries. Add {v.firstName || "them"} now and payroll will see them without a salary.</p>
            ) : o.structures.length === 0 ? (
              <p className="text-base text-text-muted sm:col-span-2">No salary structures yet. Set one up in Settings → Payroll first, or skip this step.</p>
            ) : (
              <>
                <Field label="Salary structure" error={err("structureId")}><Select value={v.structureId || undefined} onValueChange={sel("structureId")} options={opts(structures, "No salary yet")} placeholder="Choose a structure" /></Field>
                <Field label="Annual CTC" error={err("ctcPaise")}><MoneyInput valuePaise={ctc} onChangePaise={setCtc} /></Field>
              </>
            )}
          </CardBody>
        </Card>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {step === STEPS.length - 1 ? <Checkbox label="Email them an invite to set their password" checked={sendInvite} onCheckedChange={(c) => setSendInvite(!!c)} /> : <span />}
        <div className="flex justify-end gap-2">
          {step === 0 ? <Button variant="secondary" onClick={() => router.back()}>Cancel</Button> : <Button variant="secondary" onClick={() => { setError(null); setStep((s) => s - 1); }}><ArrowLeft />Back</Button>}
          {step < STEPS.length - 1 ? <Button onClick={next}>Next<ArrowRight /></Button> : <Button onClick={submit} loading={pending}><Check />Add employee</Button>}
        </div>
      </div>
    </div>
  );
}
