"use client";
import * as React from "react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Checkbox, Switch } from "@/ui/choice";
import { Select } from "@/ui/select";
import { Field, Input, Textarea } from "@/ui/field";
import { Badge } from "@/ui/badge";
import { Banner } from "@/ui/feedback";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";
import { SESSION_HOURS_OPTIONS } from "@/server/auth/network-rules";
import { setIpAllowlistAction, setMobileOtpAction, setSessionHoursAction, setSsoAction } from "@/app/(app)/settings/security/actions";

type Sso = { google: boolean; microsoft: boolean; domains: string[]; ssoOnly: boolean; microsoftTenant: string; providers: { google: { configured: boolean; hint: string }; microsoft: { configured: boolean; hint: string } } };
type Props = {
  canEdit: boolean; sessionHours: number; ipAllowlist: string[]; sso: Sso;
  mobileOtp: { enabled: boolean; provider: { name: string; configured: boolean; hint: string } };
  features: { sso: boolean; ipAllowlist: boolean; mobileOtp: boolean };
};

function NotConfigured({ hint }: { hint: string }) {
  return <Badge tone="warning">Not configured — add {hint}</Badge>;
}

/** Session length, IP allowlist, single sign-on and mobile OTP. Each card saves on its own. */
export function SignInMethods({ canEdit, sessionHours, ipAllowlist, sso, mobileOtp, features }: Props) {
  return (
    <>
      <SessionCard canEdit={canEdit} hours={sessionHours} />
      <SsoCard canEdit={canEdit} sso={sso} allowed={features.sso} />
      <MobileOtpCard canEdit={canEdit} state={mobileOtp} allowed={features.mobileOtp} />
      <IpCard canEdit={canEdit} list={ipAllowlist} allowed={features.ipAllowlist} />
    </>
  );
}

function SessionCard({ canEdit, hours }: { canEdit: boolean; hours: number }) {
  const [value, setValue] = React.useState(String(hours));
  const [pending, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title="Session length" description="How long someone stays signed in on a device before erp asks again. Applies to new sign-ins." />
      <CardBody>
        <Field label="Sign out after" className="max-w-xs">
          <Select value={value} disabled={!canEdit || pending} options={SESSION_HOURS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            onValueChange={(v) => { const prev = value; setValue(v); start(async () => { const r = await setSessionHoursAction(Number(v)); if (r.ok) toast.success("Session length saved"); else { toast.error(r.error); setValue(prev); } }); }} />
        </Field>
      </CardBody>
    </Card>
  );
}

function SsoCard({ canEdit, sso, allowed }: { canEdit: boolean; sso: Sso; allowed: boolean }) {
  const [form, setForm] = React.useState({ google: sso.google, microsoft: sso.microsoft, domains: sso.domains.join("\n"), ssoOnly: sso.ssoOnly, microsoftTenant: sso.microsoftTenant });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const disabled = !canEdit || pending;
  return (
    <Card>
      <CardHeader title="Single sign-on" description="Let people sign in with their Google Workspace or Microsoft 365 account. SSO only links to accounts that already exist in erp; it never creates new ones." />
      <CardBody className="flex flex-col gap-4">
        {!allowed && <Banner tone="info">Single sign-on is available on the Plus plan. You can look at the settings; turning a provider on needs an upgrade in Settings → Billing.</Banner>}
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Switch label="Google" checked={form.google} disabled={disabled || !sso.providers.google.configured} onCheckedChange={(c) => setForm({ ...form, google: c })} />
            {!sso.providers.google.configured && <NotConfigured hint={sso.providers.google.hint} />}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Switch label="Microsoft / Entra ID" checked={form.microsoft} disabled={disabled || !sso.providers.microsoft.configured} onCheckedChange={(c) => setForm({ ...form, microsoft: c })} />
            {!sso.providers.microsoft.configured && <NotConfigured hint={sso.providers.microsoft.hint} />}
          </div>
        </div>
        {form.microsoft && (
          <Field label="Microsoft directory (optional)" help="Your Entra tenant id or domain, e.g. acme.onmicrosoft.com. Leave empty to accept any work account." error={error?.field === "microsoftTenant" ? error.message : undefined} className="max-w-md">
            <Input value={form.microsoftTenant} disabled={disabled} onChange={(e) => setForm({ ...form, microsoftTenant: e.target.value })} />
          </Field>
        )}
        <Field label="Allowed email domains (optional)" help="One per line, e.g. acme.in. Leave empty to allow any domain. Your own email must be on one of them." error={error?.field === "domains" ? error.message : undefined} className="max-w-md">
          <Textarea rows={3} value={form.domains} disabled={disabled} onChange={(e) => setForm({ ...form, domains: e.target.value })} />
        </Field>
        <Checkbox label="Require SSO: turn off password sign-in for everyone" checked={form.ssoOnly} disabled={disabled} onCheckedChange={(c) => setForm({ ...form, ssoOnly: c === true })} />
        {form.ssoOnly && <Banner tone="warning">Make sure you can sign in with SSO before saving this. Mobile OTP (if on) still works.</Banner>}
        {canEdit && (
          <div>
            <Button loading={pending} onClick={() => start(async () => {
              setError(null);
              const r = await setSsoAction(form);
              if (r.ok) toast.success("Sign-in methods saved"); else setError({ message: r.error, field: r.field });
            })}>Save SSO settings</Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function MobileOtpCard({ canEdit, state, allowed }: { canEdit: boolean; state: Props["mobileOtp"]; allowed: boolean }) {
  const [on, setOn] = React.useState(state.enabled);
  const [pending, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title="Mobile OTP sign-in" description="A 6-digit code by SMS to the mobile number on the person's profile, as an alternative to the password." />
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Switch label="Allow sign-in with a code sent by SMS" checked={on} disabled={!canEdit || pending || (!allowed && !on)}
            onCheckedChange={(c) => { setOn(c); start(async () => { const r = await setMobileOtpAction(c); if (r.ok) toast.success(c ? "Mobile OTP on" : "Mobile OTP off"); else { toast.error(r.error); setOn(!c); } }); }} />
          {!state.provider.configured && <Badge tone="warning">Dev SMS only — add {state.provider.hint} to really send</Badge>}
        </div>
        {!state.provider.configured && on && <p className="text-sm text-text-muted">Until MSG91 keys are set, codes are only written to the local log at /dev/sms.</p>}
      </CardBody>
    </Card>
  );
}

function IpCard({ canEdit, list, allowed }: { canEdit: boolean; list: string[]; allowed: boolean }) {
  const [text, setText] = React.useState(list.join("\n"));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title="IP allowlist" description="Only allow sign-in and app use from these networks (office, VPN). Leave empty to allow everywhere." />
      <CardBody className="flex flex-col gap-3">
        {!allowed && <Banner tone="info">The IP allowlist is available on the Pro plan.</Banner>}
        <Field label="Allowed addresses or ranges" help="One per line: 203.0.113.9 or 10.0.0.0/8. Your current address must be included, so you can't lock yourself out." error={error ?? undefined} className="max-w-md">
          <Textarea rows={4} value={text} disabled={!canEdit || pending || (!allowed && !list.length)} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </Field>
        {canEdit && (
          <div>
            <Button variant="secondary" loading={pending} disabled={!allowed && !list.length} onClick={() => start(async () => {
              setError(null);
              const r = await setIpAllowlistAction(text);
              if (r.ok) toast.success(text.trim() ? "Allowlist saved" : "Allowlist removed"); else setError(r.error);
            })}>Save allowlist</Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
