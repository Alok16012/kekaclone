"use client";
import * as React from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { requestResetAction, type FormState } from "../actions";

export function ForgotForm() {
  const [state, action, pending] = React.useActionState<FormState & { sent?: boolean }, FormData>(requestResetAction, {});
  if (state.sent) {
    return (
      <div className="flex flex-col items-center gap-3 text-center" role="status">
        <span className="flex size-12 items-center justify-center rounded-pill bg-success-soft text-success-text"><MailCheck className="size-6" /></span>
        <p className="text-base">If <strong>{state.values?.email}</strong> has an account here, we&apos;ve sent a link to reset the password. It works for an hour.</p>
        <Link href="/login" className="text-base font-medium text-accent-text hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Field label="Work email" error={state.fields?.email}><Input name="email" type="email" autoComplete="username" defaultValue={state.values?.email} autoFocus required /></Field>
      <Button type="submit" size="lg" block loading={pending}>Send reset link</Button>
      <Link href="/login" className="text-center text-sm text-text-muted hover:text-text">Back to sign in</Link>
    </form>
  );
}
