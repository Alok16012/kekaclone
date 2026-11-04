"use client";
import * as React from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { Branding } from "@/server/auth/session";
import { accentProblem, derivePalette } from "@/server/modules/saas/branding-rules";
import { removeBackgroundAction, removeLogoAction, saveBrandingAction, uploadBackgroundAction, uploadLogoAction } from "@/app/(app)/settings/branding/actions";

/** Settings → Branding: logo, accent colours (with a live contrast check) and the sign-in page note. */
export function BrandingPage({ branding, canEdit, allowed, company }: { branding: Branding; canEdit: boolean; allowed: boolean; company: string }) {
  const [form, setForm] = React.useState({ accent: branding.accent ?? "", accentDark: branding.accent_dark ?? "", loginNote: branding.login_note ?? "" });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const [logoKey, setLogoKey] = React.useState(0);
  const [bgKey, setBgKey] = React.useState(0);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const bgRef = React.useRef<HTMLInputElement>(null);
  const lightProblem = form.accent ? accentProblem(form.accent, "light") : null;
  const darkProblem = form.accentDark ? accentProblem(form.accentDark, "dark") : null;
  const disabled = !canEdit || !allowed || pending;
  const preview = form.accent && !lightProblem ? derivePalette(form.accent, "light") : null;
  return (
    <div className="flex flex-col gap-4">
      {!allowed && <Banner tone="info">Company branding is available on the Plus plan. Upgrade in Settings → Billing to use your logo and colours.</Banner>}
      {!canEdit && allowed && <p className="text-sm text-text-muted">Only people who can edit company structure can change branding.</p>}
      <Card>
        <CardHeader title="Logo" description="Shown on the sign-in page and in emails. PNG, JPEG or WebP, up to 512 KB; a wide logo on a transparent background works best." />
        <CardBody className="flex flex-wrap items-center gap-4">
          <div className="flex h-20 min-w-40 items-center justify-center rounded-md border border-dashed border-border bg-surface-sunken px-4">
            {branding.logo_file_id ? (
              // eslint-disable-next-line @next/next/no-img-element -- tenant file served by our own route
              <img key={logoKey} src={`/brand/logo?v=${logoKey}-${branding.logo_file_id.slice(0, 8)}`} alt={`${company} logo`} className="max-h-14 max-w-56 object-contain" />
            ) : <span className="text-sm text-text-muted">No logo yet</span>}
          </div>
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); start(async () => { const r = await uploadLogoAction(fd); if (r.ok) { toast.success("Logo updated"); setLogoKey((k) => k + 1); if (fileRef.current) fileRef.current.value = ""; } else toast.error(r.error); }); }}>
            <input ref={fileRef} type="file" name="logo" accept="image/png,image/jpeg,image/webp" className="sr-only" id="logo-file" disabled={disabled}
              onChange={(e) => e.currentTarget.form?.requestSubmit()} />
            <Button asChild variant="secondary" disabled={disabled}><label htmlFor="logo-file" className={disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}><ImageUp />Upload logo</label></Button>
            {branding.logo_file_id && canEdit && <Button type="button" variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await removeLogoAction(); if (r.ok) toast.success("Logo removed"); else toast.error(r.error); })}><Trash2 />Remove</Button>}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sign-in page background" description="A photo or pattern behind the sign-in card. PNG, JPEG or WebP up to 2 MB; the file's bytes are checked against its type. Keep it calm so the card stays readable." />
        <CardBody className="flex flex-wrap items-center gap-4">
          <div className="flex h-24 w-40 items-center justify-center overflow-hidden rounded-md border border-dashed border-border bg-surface-sunken">
            {branding.login_bg_file_id ? (
              // eslint-disable-next-line @next/next/no-img-element -- tenant file served by our own route
              <img key={bgKey} src={`/brand/background?v=${bgKey}-${branding.login_bg_file_id.slice(0, 8)}`} alt={`${company} sign-in background`} className="size-full object-cover" />
            ) : <span className="px-2 text-center text-sm text-text-muted">No background yet</span>}
          </div>
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); start(async () => { const r = await uploadBackgroundAction(fd); if (r.ok) { toast.success("Background updated"); setBgKey((k) => k + 1); if (bgRef.current) bgRef.current.value = ""; } else toast.error(r.error); }); }}>
            <input ref={bgRef} type="file" name="background" accept="image/png,image/jpeg,image/webp" className="sr-only" id="bg-file" disabled={disabled} onChange={(e) => e.currentTarget.form?.requestSubmit()} />
            <Button asChild variant="secondary" disabled={disabled}><label htmlFor="bg-file" className={disabled ? "pointer-events-none opacity-50" : "cursor-pointer"}><ImageUp />Upload background</label></Button>
            {branding.login_bg_file_id && canEdit && <Button type="button" variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await removeBackgroundAction(); if (r.ok) toast.success("Background removed"); else toast.error(r.error); })}><Trash2 />Remove</Button>}
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Accent colour" description="Used for buttons, links and the active menu item. White text sits on it, so it must be dark enough to read (4.5:1 contrast)." />
        <CardBody className="flex flex-col gap-4">
          {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Accent (light theme)" help="Hex, e.g. #1b7f4c. Leave empty for erp's blue." error={error?.field === "accent" ? error.message : lightProblem ?? undefined}>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Pick accent colour" value={/^#[0-9a-f]{6}$/i.test(form.accent) ? form.accent : "#2f5bea"} disabled={disabled} onChange={(e) => setForm({ ...form, accent: e.target.value })} className="size-9 shrink-0 cursor-pointer rounded-md border border-border-input bg-surface p-0.5" />
                <Input value={form.accent} disabled={disabled} onChange={(e) => setForm({ ...form, accent: e.target.value })} placeholder="#2f5bea" maxLength={7} spellCheck={false} />
              </div>
            </Field>
            <Field label="Accent (dark theme, optional)" help="Still needs 4.5:1 against white (buttons keep white text) and must stay visible on dark surfaces. Defaults to the light accent." error={error?.field === "accentDark" ? error.message : darkProblem ?? undefined}>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Pick dark-theme accent colour" value={/^#[0-9a-f]{6}$/i.test(form.accentDark) ? form.accentDark : "#3a63e8"} disabled={disabled} onChange={(e) => setForm({ ...form, accentDark: e.target.value })} className="size-9 shrink-0 cursor-pointer rounded-md border border-border-input bg-surface p-0.5" />
                <Input value={form.accentDark} disabled={disabled} onChange={(e) => setForm({ ...form, accentDark: e.target.value })} placeholder="#3a63e8" maxLength={7} spellCheck={false} />
              </div>
            </Field>
          </div>
          {preview && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3" aria-label="Preview">
              <span className="rounded-md px-3 py-1.5 text-sm font-medium text-white" style={{ background: preview.accent }}>Primary button</span>
              <span className="rounded-md px-3 py-1.5 text-sm font-medium" style={{ background: preview.soft, color: preview.text }}>Active menu item</span>
              <span className="text-sm font-medium underline" style={{ color: preview.text }}>A link</span>
            </div>
          )}
          <Field label="Sign-in page note (optional)" help="Shown under the heading on the sign-in page, e.g. 'Use your @acme.in Google account.'" error={error?.field === "loginNote" ? error.message : undefined}>
            <Input value={form.loginNote} disabled={disabled} onChange={(e) => setForm({ ...form, loginNote: e.target.value })} maxLength={200} />
          </Field>
          {canEdit && allowed && (
            <div><Button loading={pending} disabled={!!lightProblem || !!darkProblem} onClick={() => start(async () => { setError(null); const r = await saveBrandingAction(form); if (r.ok) toast.success("Branding saved. Reload to see it everywhere."); else setError({ message: r.error, field: r.field }); })}>Save branding</Button></div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
