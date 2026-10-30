"use client";
import * as React from "react";
import { ChartBar, ImagePlus, Megaphone, PenLine, Plus, Sparkles, X } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Checkbox, Segmented, Switch } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { IMAGE_MIME, LIMITS, endOfDayIST, type Audience, type PostKind } from "@/server/modules/engage/rules";
import type { ComposerOptions, FeedItem } from "@/server/modules/engage/service";
import { createPostAction, uploadImageAction } from "@/app/(app)/engage/actions";
import { BadgeIcon } from "./badge-icon";

type Upload = { id: string; url: string; name: string } | { id: null; url: string; name: string };
const KINDS: { value: PostKind; label: string; icon: React.ReactNode }[] = [
  { value: "post", label: "Post", icon: <PenLine /> },
  { value: "poll", label: "Poll", icon: <ChartBar /> },
  { value: "praise", label: "Praise", icon: <Sparkles /> },
  { value: "announcement", label: "Announcement", icon: <Megaphone /> },
];

/** Composer: write a post, run a poll, praise someone, or (with access) make an announcement. Mount it only while open: each opening starts fresh. */
export function Composer({ open, onOpenChange, initialKind, options, people, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; initialKind: PostKind;
  options: ComposerOptions; people: Person[]; onCreated: (item: FeedItem | null, scheduledFor: string | null) => void;
}) {
  const canAnnounce = !!options.announce;
  const [kind, setKind] = React.useState<PostKind>(initialKind);
  const [body, setBody] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [share, setShare] = React.useState<"org" | "dept">("org");
  const [annType, setAnnType] = React.useState<Audience["type"]>("org");
  const [groupIds, setGroupIds] = React.useState<string[]>([]);
  const [pinUntil, setPinUntil] = React.useState("");
  const [later, setLater] = React.useState(false);
  const [publishAt, setPublishAt] = React.useState("");
  const [pollOpts, setPollOpts] = React.useState(["", ""]);
  const [multiple, setMultiple] = React.useState(false);
  const [anonymous, setAnonymous] = React.useState(false);
  const [endsOn, setEndsOn] = React.useState("");
  const [recipients, setRecipients] = React.useState<string[]>([]);
  const [badgeId, setBadgeId] = React.useState<string | null>(null);
  const [uploads, setUploads] = React.useState<Upload[]>([]);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const fileRef = React.useRef<HTMLInputElement>(null);

  // announcement audiences the actor may pick (scoped HR only sees their own departments / locations)
  const scope = options.announce;
  const depts = options.departments.filter((d) => scope?.global || scope?.departments.includes(d.id));
  const locs = options.locations.filter((l) => scope?.global || scope?.locations.includes(l.id));
  const annTypes = [
    ...(scope?.global ? [{ value: "org" as const, label: "Everyone" }] : []),
    ...(depts.length ? [{ value: "departments" as const, label: "Departments" }] : []),
    ...(locs.length ? [{ value: "locations" as const, label: "Locations" }] : []),
  ];
  const audType: Audience["type"] = annTypes.some((t) => t.value === annType) ? annType : (annTypes[0]?.value ?? "org");

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    let count = uploads.length;
    for (const f of Array.from(files)) {
      if (count >= LIMITS.images) { toast.error(`Add up to ${LIMITS.images} images.`); break; }
      if (!(IMAGE_MIME as readonly string[]).includes(f.type)) { toast.error(`${f.name}: use a JPG, PNG, WebP or GIF image.`); continue; }
      if (f.size > LIMITS.imageBytes) { toast.error(`${f.name} is over 5 MB.`); continue; }
      count++;
      const preview = URL.createObjectURL(f);
      setUploads((u) => [...u, { id: null, url: preview, name: f.name }]);
      const form = new FormData();
      form.set("file", f);
      const r = await uploadImageAction(form);
      setUploads((u) => r.ok ? u.map((x) => (x.url === preview ? { id: r.data!.id, url: preview, name: f.name } : x)) : u.filter((x) => x.url !== preview));
      if (!r.ok) toast.error(r.error);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const uploading = uploads.some((u) => u.id === null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const audience: Audience = kind === "announcement"
      ? (audType === "org" ? { type: "org" } : { type: audType, ids: groupIds })
      : share === "dept" && options.myDepartment ? { type: "departments", ids: [options.myDepartment.id] } : { type: "org" };
    const input = {
      kind, body, audience,
      title: kind === "announcement" ? title : null,
      mediaFileIds: kind === "post" || kind === "announcement" ? uploads.flatMap((u) => (u.id ? [u.id] : [])) : [],
      poll: kind === "poll" ? { options: pollOpts, multiple, anonymous, endsAt: endsOn ? endOfDayIST(endsOn).toISOString() : null } : undefined,
      praise: kind === "praise" ? { recipientIds: recipients, badgeId: badgeId ?? "" } : undefined,
      pinnedUntil: kind === "announcement" && pinUntil ? pinUntil : null,
      publishAt: kind === "announcement" && later && publishAt ? new Date(publishAt).toISOString() : null,
    };
    if (kind === "announcement" && later && !publishAt) { setError({ message: "Pick when to publish it.", field: "publishAt" }); return; }
    start(async () => {
      const r = await createPostAction(input);
      if (!r.ok) { setError({ message: r.error, field: (r as { field?: string }).field }); return; }
      onCreated(r.data!.item, r.data!.scheduledFor);
      onOpenChange(false);
    });
  };

  const err = (field: string) => (error?.field === field ? error.message : undefined);
  const general = error && !["body", "title", "options", "endsAt", "recipients", "badge", "audience", "pinnedUntil", "publishAt", "media"].includes(error.field ?? "") ? error.message : null;
  const kinds = KINDS.filter((k) => k.value !== "announcement" || canAnnounce);
  const submitLabel = { post: "Post", poll: "Start poll", praise: "Send praise", announcement: later ? "Schedule" : "Publish" }[kind];

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="lg" title="Create" description="Share with your colleagues on the Home wall."
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" form="composer-form" loading={busy} disabled={uploading}>{submitLabel}</Button>
      </>}>
      <form id="composer-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div role="radiogroup" aria-label="What would you like to share?" className="flex gap-1 overflow-x-auto rounded-md bg-surface-hover p-0.5">
          {kinds.map((k) => (
            <button key={k.value} type="button" role="radio" aria-checked={kind === k.value} onClick={() => { setKind(k.value); setError(null); }}
              className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-3 text-sm font-medium text-text-muted transition-colors [&_svg]:size-4 focus-visible:outline-2 focus-visible:outline-focus",
                kind === k.value && "bg-surface text-text shadow-card")}>
              {k.icon}{k.label}
            </button>
          ))}
        </div>

        {general && <Banner tone="danger">{general}</Banner>}

        {kind === "praise" && (
          <>
            <Field label="Who do you want to praise?" required error={err("recipients")} help={`Up to ${LIMITS.recipients} people.`}>
              <EmployeePicker people={people} value={recipients} onChange={setRecipients} multiple placeholder="Search colleagues" />
            </Field>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">Badge<span aria-hidden className="ml-0.5 text-danger">*</span></legend>
              {options.badges.length === 0 ? (
                <p className="text-base text-text-muted">No badges are set up yet. Ask HR to add some.</p>
              ) : (
                <div role="radiogroup" aria-label="Badge" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {options.badges.map((b) => (
                    <button key={b.id} type="button" role="radio" aria-checked={badgeId === b.id} onClick={() => setBadgeId(b.id)}
                      className={cn("flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                        badgeId === b.id ? "border-accent bg-accent-soft/50" : "border-border hover:bg-surface-hover")}>
                      <BadgeIcon icon={b.icon} size="sm" />{b.name}
                    </button>
                  ))}
                </div>
              )}
              {err("badge") && <p role="alert" className="text-sm text-danger-text">{err("badge")}</p>}
            </fieldset>
          </>
        )}

        {kind === "announcement" && (
          <Field label="Title" required error={err("title")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={LIMITS.title} placeholder="Office closed on Friday" />
          </Field>
        )}

        <Field label={{ post: "What's on your mind?", poll: "Question", praise: "What did they do?", announcement: "Message" }[kind]} required={kind !== "post"} error={err("body")}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={kind === "poll" ? 2 : 4}
            maxLength={kind === "poll" ? LIMITS.question : kind === "praise" ? LIMITS.praise : LIMITS.body}
            placeholder={{ post: "Share an update, a win or a question", poll: "Where should we go for the team lunch?", praise: "Thank them for something specific", announcement: "The details everyone needs to know" }[kind]} />
        </Field>

        {kind === "poll" && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Options<span aria-hidden className="ml-0.5 text-danger">*</span></legend>
              {pollOpts.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input aria-label={`Option ${i + 1}`} value={o} maxLength={LIMITS.optionLabel} placeholder={`Option ${i + 1}`}
                    onChange={(e) => setPollOpts((p) => p.map((x, j) => (j === i ? e.target.value : x)))} aria-invalid={!!err("options") || undefined} />
                  {pollOpts.length > LIMITS.pollOptionsMin && <IconButton label={`Remove option ${i + 1}`} size="icon-sm" onClick={() => setPollOpts((p) => p.filter((_, j) => j !== i))}><X /></IconButton>}
                </div>
              ))}
              {pollOpts.length < LIMITS.pollOptionsMax && <Button variant="ghost" size="sm" className="self-start" onClick={() => setPollOpts((p) => [...p, ""])}><Plus />Add option</Button>}
              {err("options") && <p role="alert" className="text-sm text-danger-text">{err("options")}</p>}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-3">
                <Switch checked={multiple} onCheckedChange={setMultiple} label="Allow more than one answer" />
                <Switch checked={anonymous} onCheckedChange={setAnonymous} label="Anonymous votes" />
              </div>
              <Field label="Ends on" help="Leave empty to keep it open." error={err("endsAt")}>
                <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
              </Field>
            </div>
          </>
        )}

        {kind === "announcement" && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Who should see it?</legend>
              {annTypes.length > 1 && <Segmented label="Audience" value={audType} onChange={(v) => { setAnnType(v); setGroupIds([]); }} options={annTypes} />}
              {audType !== "org" && (
                <div className="max-h-44 overflow-y-auto rounded-md border border-border p-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(audType === "departments" ? depts : locs).map((g) => (
                      <Checkbox key={g.id} label={g.name} checked={groupIds.includes(g.id)} onCheckedChange={(c) => setGroupIds((ids) => (c ? [...ids, g.id] : ids.filter((x) => x !== g.id)))} />
                    ))}
                  </div>
                </div>
              )}
              {err("audience") && <p role="alert" className="text-sm text-danger-text">{err("audience")}</p>}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pin to the top until" help="Optional. Pinned announcements stay above the feed." error={err("pinnedUntil")}>
                <Input type="date" value={pinUntil} onChange={(e) => setPinUntil(e.target.value)} />
              </Field>
              <div className="flex flex-col gap-2">
                <Switch checked={later} onCheckedChange={setLater} label="Publish later" />
                {later && (
                  <Field label="Publish on" error={err("publishAt")}>
                    <Input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} />
                  </Field>
                )}
              </div>
            </div>
          </>
        )}

        {(kind === "post" || kind === "announcement") && (
          <div className="flex flex-col gap-2">
            {uploads.length > 0 && (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Images">
                {uploads.map((u) => (
                  <li key={u.url} className="relative overflow-hidden rounded-md border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen file */}
                    <img src={u.url} alt={u.name} className={cn("aspect-square w-full object-cover", u.id === null && "opacity-50")} />
                    {u.id === null
                      ? <span className="absolute inset-x-0 bottom-0 bg-surface/80 px-2 py-1 text-xs">Uploading…</span>
                      : <IconButton label={`Remove ${u.name}`} size="icon-sm" variant="secondary" className="absolute right-1 top-1" onClick={() => setUploads((x) => x.filter((y) => y.url !== u.url))}><X /></IconButton>}
                  </li>
                ))}
              </ul>
            )}
            {err("media") && <p role="alert" className="text-sm text-danger-text">{err("media")}</p>}
            <input ref={fileRef} type="file" accept={IMAGE_MIME.join(",")} multiple className="sr-only" id="composer-file" tabIndex={-1} onChange={(e) => pickFiles(e.target.files)} />
            <Button variant="ghost" size="sm" className="self-start" disabled={uploads.length >= LIMITS.images} onClick={() => fileRef.current?.click()}>
              <ImagePlus />Add image<span className="text-text-muted">· JPG, PNG, WebP or GIF up to 5 MB</span>
            </Button>
          </div>
        )}

        {kind !== "announcement" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium" id="share-label">Share with</span>
            {options.myDepartment ? (
              <Segmented label="Share with" value={share} onChange={setShare} options={[{ value: "org", label: "Everyone" }, { value: "dept", label: options.myDepartment.name }]} />
            ) : (
              <p className="text-sm text-text-muted">Everyone in the company</p>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
