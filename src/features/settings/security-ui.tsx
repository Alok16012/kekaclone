"use client";
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { RadioGroup, Switch } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { setMfaModeAction, setMyMfaAction } from "@/app/(app)/actions";

export function SecuritySettings({ mode, mine, canEdit }: { mode: "off" | "optional" | "required"; mine: boolean; canEdit: boolean }) {
  const [value, setValue] = React.useState(mode);
  const [pending, start] = React.useTransition();
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Sign-in codes" description="After the password, erp emails a 6-digit code that must be entered to finish signing in." />
        <CardBody className="flex flex-col gap-4">
          <RadioGroup value={value} disabled={!canEdit || pending} aria-label="Sign-in codes"
            onValueChange={(v) => {
              const prev = value; setValue(v as typeof value);
              start(async () => { const r = await setMfaModeAction(v); if (r.ok) toast.success("Sign-in security updated"); else { toast.error(r.error); setValue(prev); } });
            }}
            options={[
              { value: "off", label: "Off", hint: "Password only." },
              { value: "optional", label: "Each person decides", hint: "People can turn codes on for themselves from their profile." },
              { value: "required", label: "Required for everyone", hint: "Recommended for companies handling payroll and personal data." },
            ]} />
          {!canEdit && <p className="text-sm text-text-muted">Only people who can change sign-in security can edit this.</p>}
        </CardBody>
      </Card>
      <MyCodeSwitch mode={value} mine={mine} />
    </div>
  );
}

export function MyCodeSwitch({ mode, mine }: { mode: "off" | "optional" | "required"; mine: boolean }) {
  const [on, setOn] = React.useState(mine);
  const [pending, start] = React.useTransition();
  if (mode === "off") return null;
  return (
    <Card>
      <CardHeader title="Your sign-in" />
      <CardBody>
        {mode === "required" ? (
          <Banner tone="info" title="Codes are on for everyone"><span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" aria-hidden />Your company asks for a code at every sign-in.</span></Banner>
        ) : (
          <Switch label="Ask me for a code from my email when I sign in" checked={on} disabled={pending}
            onCheckedChange={(c) => { setOn(c); start(async () => { const r = await setMyMfaAction(c); if (r.ok) toast.success(c ? "Sign-in codes on" : "Sign-in codes off"); else { toast.error(r.error); setOn(!c); } }); }} />
        )}
      </CardBody>
    </Card>
  );
}
