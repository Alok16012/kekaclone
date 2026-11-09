"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { MailCheck } from "lucide-react";
import { signupAction, verifySignupAction, type FormState } from "../actions";

export function SignupForm({ rootDomain }: { rootDomain: string }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(signupAction, {});
  const [sub, setSub] = React.useState(state.values?.subdomain ?? "");
  const [touched, setTouched] = React.useState(false);
  const v = state.values ?? {};
  const f = state.fields ?? {};
  if (state.verify) return <VerifyStep key={state.verify.maskedEmail} initial={state} />;
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

/** Step 2: the 6-digit code emailed to the address on the form. The workspace is created only after it checks out. */
function VerifyStep({ initial }: { initial: FormState }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(verifySignupAction, initial);
  if (!state.verify) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="danger">{state.error ?? "Your sign-up timed out."}</Banner>
        <Button size="lg" block onClick={() => window.location.reload()}>Start again</Button>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <div className="flex items-start gap-3 rounded-md bg-accent-soft px-4 py-3 text-accent-text" role="status">
        <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="text-base">We emailed a 6-digit code to <strong>{state.verify.maskedEmail}</strong>. Enter it to confirm your email and create your workspace. It works for 15 minutes.</p>
      </div>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      {state.notice && !state.error && <Banner tone="success">{state.notice}</Banner>}
      <Field label="Verification code" required>
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} autoFocus required className="text-lg tracking-[0.4em] tabular" />
      </Field>
      <Button type="submit" size="lg" block loading={pending}>Verify and create workspace</Button>
      <Button type="submit" name="intent" value="resend" variant="ghost" formNoValidate disabled={pending}>Send a new code</Button>
      <Button type="button" variant="ghost" onClick={() => window.location.reload()} disabled={pending}>Use a different email</Button>
    </form>
  );
}
