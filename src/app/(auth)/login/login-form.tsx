"use client";
import * as React from "react";
import Link from "next/link";
import { MailCheck, MessageSquareText } from "lucide-react";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { Checkbox } from "@/ui/choice";
import { Segmented } from "@/ui/choice";
import { SSO_LABELS, type SsoProvider } from "@/server/modules/auth/sso-types";
import { loginAction, mobileOtpStartAction, mobileOtpVerifyAction, verifyCodeAction, type FormState } from "../actions";

type Props = { next?: string; sso?: SsoProvider[]; password?: boolean; mobileOtp?: boolean; ssoError?: string };

/** Email + password (default), SSO buttons when the company turned them on, and a mobile OTP tab when enabled. */
export function LoginForm({ next, sso = [], password = true, mobileOtp = false, ssoError }: Props) {
  const [method, setMethod] = React.useState<"email" | "mobile">(password ? "email" : mobileOtp ? "mobile" : "email");
  const showTabs = password && mobileOtp;
  return (
    <div className="flex flex-col gap-4">
      {ssoError && <Banner tone="danger">{ssoError}</Banner>}
      {sso.length > 0 && (
        <div className="flex flex-col gap-2">
          {sso.map((p) => (
            <Button key={p} asChild variant="secondary" size="lg" block>
              <a href={`/auth/sso/${p}/start${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Continue with {SSO_LABELS[p]}</a>
            </Button>
          ))}
          {(password || mobileOtp) && <div className="my-1 flex items-center gap-3 text-sm text-text-muted" aria-hidden><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>}
        </div>
      )}
      {showTabs && <Segmented value={method} onChange={setMethod} label="Sign-in method" options={[{ value: "email", label: "Email" }, { value: "mobile", label: "Mobile OTP" }]} />}
      {method === "mobile" && mobileOtp ? <MobileOtpForm next={next} /> : password ? <PasswordForm next={next} /> : sso.length === 0 && !mobileOtp ? <Banner tone="warning">No sign-in method is turned on for this workspace. Ask your admin.</Banner> : null}
    </div>
  );
}

function PasswordForm({ next }: { next?: string }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(loginAction, {});
  const f = state.fields ?? {};
  React.useEffect(() => { if (state.redirectTo) window.location.assign(state.redirectTo); }, [state.redirectTo]);
  if (state.mfa) return <CodeStep key={state.mfa.maskedEmail + JSON.stringify(state.values)} initial={state} />;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Work email" error={f.email}><Input name="email" type="email" autoComplete="username" defaultValue={state.values?.email} autoFocus required /></Field>
      <Field label="Password" error={f.password}><Input name="password" type="password" autoComplete="current-password" required /></Field>
      <Link href="/forgot-password" className="-mt-2 self-end text-sm font-medium text-accent-text hover:underline">Forgot password?</Link>
      <Button type="submit" size="lg" block loading={pending || !!state.redirectTo}>Sign in</Button>
    </form>
  );
}

/** Second step when the company (or the person) has sign-in codes turned on. */
function CodeStep({ initial }: { initial: FormState }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(verifyCodeAction, initial);
  React.useEffect(() => { if (state.redirectTo) window.location.assign(state.redirectTo); }, [state.redirectTo]);
  if (!state.mfa && !state.redirectTo) {
    // challenge ended (expired / too many tries): back to the password step with the message
    return <RestartNotice message={state.error} />;
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <div className="flex items-start gap-3 rounded-md bg-accent-soft px-4 py-3 text-accent-text" role="status">
        <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="text-base">We emailed a 6-digit code to <strong>{state.mfa?.maskedEmail}</strong>. It works for 10 minutes.</p>
      </div>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      {state.notice && !state.error && <Banner tone="success">{state.notice}</Banner>}
      <Field label="Sign-in code">
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} autoFocus required className="text-lg tracking-[0.4em] tabular" />
      </Field>
      <Checkbox name="remember" value="on" label="Remember this device for 30 days" />
      <Button type="submit" size="lg" block loading={pending || !!state.redirectTo}>Verify and sign in</Button>
      <Button type="submit" name="intent" value="resend" variant="ghost" formNoValidate>Send a new code</Button>
    </form>
  );
}

/** Mobile OTP: number first, then the 6-digit code from the SMS. */
function MobileOtpForm({ next }: { next?: string }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(mobileOtpStartAction, {});
  const f = state.fields ?? {};
  if (state.otp) return <MobileCodeStep key={state.otp.maskedPhone} initial={state} />;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Mobile number" help="The number on your erp profile." error={f.phone}>
        <Input name="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="98765 43210" defaultValue={state.values?.phone} autoFocus required />
      </Field>
      <Button type="submit" size="lg" block loading={pending}>Send code</Button>
    </form>
  );
}

function MobileCodeStep({ initial }: { initial: FormState }) {
  const [state, action, pending] = React.useActionState<FormState, FormData>(mobileOtpVerifyAction, initial);
  React.useEffect(() => { if (state.redirectTo) window.location.assign(state.redirectTo); }, [state.redirectTo]);
  if (!state.otp && !state.redirectTo) return <RestartNotice message={state.error} />;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <div className="flex items-start gap-3 rounded-md bg-accent-soft px-4 py-3 text-accent-text" role="status">
        <MessageSquareText className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p className="text-base">If <strong>{state.otp?.maskedPhone}</strong> belongs to an account here, we texted it a 6-digit code. It works for 5 minutes.</p>
      </div>
      {state.error && <Banner tone="danger">{state.error}</Banner>}
      <Field label="Code from SMS">
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} autoFocus required className="text-lg tracking-[0.4em] tabular" />
      </Field>
      <Button type="submit" size="lg" block loading={pending || !!state.redirectTo}>Verify and sign in</Button>
      <Button type="button" variant="ghost" onClick={() => window.location.reload()}>Use a different number</Button>
    </form>
  );
}

function RestartNotice({ message }: { message?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="danger">{message ?? "Your sign-in timed out."}</Banner>
      <Button size="lg" block onClick={() => window.location.reload()}>Start again</Button>
    </div>
  );
}
