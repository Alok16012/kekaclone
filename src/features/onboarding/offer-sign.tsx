"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileSignature, FileText } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { joinerSignAction, joinerSignCodeAction } from "@/app/join/offer-actions";

export type JoinerOfferDTO = { title: string; signed: boolean; signed_name: string | null; signed_at: string | null; codeSent: boolean; sendTo: string | null; fullName: string };

/** Joiner portal: read the offer letter, then sign it with your typed full name and a code emailed to you. */
export function JoinerOfferSign({ token, offer }: { token: string; offer: JoinerOfferDTO }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(offer.codeSent ? offer.sendTo : null);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const href = `/join/${token}/offer`;
  if (offer.signed) {
    return (
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><CheckCircle2 aria-hidden className="size-4 text-success" />{offer.title}</span>}
          description={`Signed${offer.signed_name ? ` by ${offer.signed_name}` : ""}${offer.signed_at ? ` on ${new Date(offer.signed_at).toLocaleDateString("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" })}` : ""}.`} />
        <CardBody><Button asChild variant="secondary" size="sm"><a href={href} target="_blank" rel="noreferrer"><FileText />Download signed copy</a></Button></CardBody>
      </Card>
    );
  }
  const askCode = () => start(async () => {
    setError(null);
    const r = await joinerSignCodeAction(token);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    setSent(r.data!.sentTo);
  });
  const sign = () => start(async () => {
    setError(null);
    const r = await joinerSignAction(token, name, code);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    router.refresh();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><FileSignature aria-hidden className="size-4 text-accent-text" />Sign your offer letter</span>}
        description="Read the letter first. Signing means you accept the offer as written." />
      <CardBody className="flex flex-col gap-4">
        <Button asChild variant="secondary" size="sm" className="self-start"><a href={href} target="_blank" rel="noreferrer"><FileText />Read {offer.title}</a></Button>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Type your full name" required help={`Exactly as shown: ${offer.fullName}`} error={err("typedName")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} autoComplete="name" />
        </Field>
        {!sent ? (
          <Button className="self-start" loading={busy} onClick={askCode} disabled={!name.trim()}>Email me a code</Button>
        ) : (
          <>
            <p className="text-sm text-text-muted" aria-live="polite">We sent a 6-digit code to {sent}. It works for 10 minutes.</p>
            <Field label="Code" required error={err("code")}>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className="max-w-40" />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={sign} disabled={code.length !== 6 || !name.trim()}>Sign and accept</Button>
              <Button variant="ghost" onClick={askCode} disabled={busy}>Send a new code</Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
