"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { signupAction, type FormState } from "../actions";

export function SignupForm({ rootDomain }: { rootDomain: string }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(signupAction, {});
  const [sub, setSub] = React.useState(state.values?.subdomain ?? "");
  const [touched, setTouched] = React.useState(false);
  const v = state.values ?? {};
  const f = state.fields ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <Field label="Company name" required error={f.company}>
        <Input name="company" autoComplete="organization" defaultValue={v.company} required
          onChange={(e) => { if (!touched) setSub(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32)); }} />
      </Field>
      <Field label="Workspace address" required error={f.subdomain} help={`Your team signs in at ${sub || "yourcompany"}.${rootDomain}`}>
        <Input name="subdomain" value={sub} required autoCapitalize="none" spellCheck={false}
          onChange={(e) => { setTouched(true); setSub(e.target.value.toLowerCase()); }}
          trailing={<span className="text-sm">.{rootDomain.split(":")[0]}</span>} className="pr-28" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required error={f.firstName}><Input name="firstName" autoComplete="given-name" defaultValue={v.firstName} required /></Field>
        <Field label="Last name" error={f.lastName}><Input name="lastName" autoComplete="family-name" defaultValue={v.lastName} /></Field>
      </div>
      <Field label="Work email" required error={f.email}><Input name="email" type="email" autoComplete="email" defaultValue={v.email} required /></Field>
      <Field label="Password" required error={f.password} help="At least 10 characters"><Input name="password" type="password" autoComplete="new-password" required /></Field>
      <Button type="submit" size="lg" block loading={pending}>Create workspace</Button>
      <p className="text-center text-sm text-text-muted">Free for 30 days. No card needed.</p>
    </form>
  );
}
