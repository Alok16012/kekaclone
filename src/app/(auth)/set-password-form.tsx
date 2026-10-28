"use client";
import * as React from "react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { passwordProblem } from "@/server/auth/password-policy";
import { setPasswordAction, type FormState } from "./actions";

export function SetPasswordForm({ token, purpose, email }: { token: string; purpose: "invite" | "reset_password"; email: string }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(setPasswordAction, {});
  const [pw, setPw] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  React.useEffect(() => { if (state.redirectTo) window.location.assign(state.redirectTo); }, [state.redirectTo]);
  const live = touched && pw ? passwordProblem(pw, email) : null;
  const f = state.fields ?? {};
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="purpose" value={purpose} />
      <input type="email" name="username" value={email} autoComplete="username" readOnly hidden />
      <Field label="New password" error={f.password ?? live ?? undefined} help={!live && !f.password ? "At least 10 characters. A short phrase works well." : undefined}>
        <Input name="password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} onBlur={() => setTouched(true)} autoFocus required />
      </Field>
      <Field label="Type it again" error={f.confirm}><Input name="confirm" type="password" autoComplete="new-password" required /></Field>
      <Button type="submit" size="lg" block loading={pending || !!state.redirectTo}>{purpose === "invite" ? "Set password and sign in" : "Save new password"}</Button>
    </form>
  );
}
