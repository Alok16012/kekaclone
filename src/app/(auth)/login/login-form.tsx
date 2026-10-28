"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { loginAction, type FormState } from "../actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(loginAction, {});
  const f = state.fields ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Work email" error={f.email}><Input name="email" type="email" autoComplete="username" defaultValue={state.values?.email} autoFocus required /></Field>
      <Field label="Password" error={f.password}><Input name="password" type="password" autoComplete="current-password" required /></Field>
      <Button type="submit" size="lg" block loading={pending}>Sign in</Button>
    </form>
  );
}
