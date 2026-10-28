"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { createEmployeeAction } from "@/app/(app)/actions";

type Opt = { id: string; name: string };

/** M0: one page with the essentials. The 4-step wizard (job, work policies, compensation) replaces it in M1. */
export function AddEmployeeForm({ departments, designations, locations, people, today }: { departments: Opt[]; designations: Opt[]; locations: Opt[]; people: Person[]; today: string }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [v, setV] = React.useState({ firstName: "", lastName: "", workEmail: "", mobile: "", employeeNumber: "", joiningDate: today, departmentId: "", designationId: "", locationId: locations[0]?.id ?? "", managerId: "" });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  const err = (f: string) => (error?.field === f ? error.message : undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createEmployeeAction({
        ...v, lastName: v.lastName || undefined, mobile: v.mobile || undefined, employeeNumber: v.employeeNumber || undefined,
        departmentId: v.departmentId || undefined, designationId: v.designationId || undefined, locationId: v.locationId || undefined, managerId: v.managerId || undefined,
      });
      if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
      toast.success(`${v.firstName} added`, { description: `Employee number ${r.data!.employeeNumber}` });
      router.push("/org/employees");
    });
  };
  const opts = (xs: Opt[]) => xs.map((x) => ({ value: x.id, label: x.name }));
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
      <Card>
        <CardHeader title="Basic details" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={err("firstName")}><Input value={v.firstName} onChange={set("firstName")} autoComplete="off" required /></Field>
          <Field label="Last name" error={err("lastName")}><Input value={v.lastName} onChange={set("lastName")} autoComplete="off" /></Field>
          <Field label="Work email" required error={err("workEmail")}><Input type="email" value={v.workEmail} onChange={set("workEmail")} autoComplete="off" required /></Field>
          <Field label="Mobile" error={err("mobile")}><Input type="tel" value={v.mobile} onChange={set("mobile")} placeholder="+91" /></Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Job" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Joining date" required error={err("joiningDate")}><Input type="date" value={v.joiningDate} onChange={set("joiningDate")} required /></Field>
          <Field label="Employee number" help="Leave empty to generate one" error={err("employeeNumber")}><Input value={v.employeeNumber} onChange={set("employeeNumber")} /></Field>
          <Field label="Department"><Select value={v.departmentId || undefined} onValueChange={(x) => setV((s) => ({ ...s, departmentId: x }))} options={opts(departments)} placeholder="Choose department" /></Field>
          <Field label="Designation"><Select value={v.designationId || undefined} onValueChange={(x) => setV((s) => ({ ...s, designationId: x }))} options={opts(designations)} placeholder="Choose designation" /></Field>
          <Field label="Location"><Select value={v.locationId || undefined} onValueChange={(x) => setV((s) => ({ ...s, locationId: x }))} options={opts(locations)} /></Field>
          <Field label="Reporting manager" help="Approves their leave and attendance requests"><EmployeePicker people={people} value={v.managerId ? [v.managerId] : []} onChange={(ids) => setV((s) => ({ ...s, managerId: ids[0] ?? "" }))} placeholder="Choose a manager" /></Field>
        </CardBody>
      </Card>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.back()}>Cancel</Button>
        <Button type="submit" loading={pending}>Add employee</Button>
      </div>
    </form>
  );
}
