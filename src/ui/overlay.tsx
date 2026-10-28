"use client";
import * as React from "react";
import { Dialog as D, AlertDialog as AD, DropdownMenu as DM, Tooltip as TT, Popover as P } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

const overlay = "fixed inset-0 z-60 bg-overlay/45 animate-fade-in";

/** Centered modal. Focus is trapped, Esc and the X close it, focus returns to the trigger. Full-screen below sm. */
export function Modal({ open, onOpenChange, title, description, children, footer, size = "md", trigger }: {
  open?: boolean; onOpenChange?: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode;
  children?: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg"; trigger?: React.ReactNode;
}) {
  const w = { sm: "sm:max-w-(--size-modal-sm)", md: "sm:max-w-(--size-modal-md)", lg: "sm:max-w-(--size-modal-lg)" }[size];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content className={cn("fixed inset-0 z-60 flex flex-col bg-surface shadow-modal animate-pop-in focus:outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[85vh] sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg", w)}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <D.Title className="text-lg font-semibold text-text">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-sm text-text-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
            </div>
            <D.Close asChild><Button variant="ghost" size="icon-sm" aria-label="Close"><X /></Button></D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Right-side drawer for details (leave request, candidate, payslip). Bottom sheet below sm. */
export function Drawer({ open, onOpenChange, title, description, children, footer, trigger }: {
  open?: boolean; onOpenChange?: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; trigger?: React.ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content className="fixed inset-x-0 bottom-0 z-60 flex max-h-[90vh] flex-col rounded-t-xl bg-surface shadow-modal animate-pop-in focus:outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-(--size-drawer) sm:rounded-none sm:animate-slide-in">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <D.Title className="text-lg font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-sm text-text-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
            </div>
            <D.Close asChild><Button variant="ghost" size="icon-sm" aria-label="Close"><X /></Button></D.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Confirmation for irreversible actions. Focus starts on Cancel, not on the destructive button. */
export function ConfirmDialog({ trigger, title, description, confirmLabel, tone = "danger", onConfirm, open: openProp, onOpenChange }: {
  trigger?: React.ReactNode; title: string; description: React.ReactNode; confirmLabel: string; tone?: "danger" | "primary"; onConfirm: () => void | Promise<void>;
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o); };
  return (
    <AD.Root open={open} onOpenChange={setOpen}>
      {trigger && <AD.Trigger asChild>{trigger}</AD.Trigger>}
      <AD.Portal>
        <AD.Overlay className={overlay} />
        <AD.Content className="fixed left-1/2 top-1/2 z-60 w-[calc(100%-2rem)] max-w-(--size-modal-sm) -translate-x-1/2 -translate-y-1/2 rounded-lg bg-surface p-5 shadow-modal animate-pop-in">
          <AD.Title className="text-lg font-semibold">{title}</AD.Title>
          <AD.Description className="mt-2 text-base text-text-muted">{description}</AD.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AD.Cancel asChild><Button variant="secondary">Cancel</Button></AD.Cancel>
            <Button variant={tone} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); setOpen(false); } finally { setBusy(false); } }}>
              {confirmLabel}
            </Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}

export function Menu({ trigger, items, align = "end" }: {
  trigger: React.ReactNode; align?: "start" | "end";
  items: ({ label: React.ReactNode; icon?: React.ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean } | "separator")[];
}) {
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} sideOffset={4} className="z-40 min-w-44 rounded-md border border-border bg-surface p-1 shadow-pop animate-pop-in">
          {items.map((it, i) => it === "separator" ? <DM.Separator key={i} className="my-1 h-px bg-border" /> : (
            <DM.Item key={i} disabled={it.disabled} onSelect={it.onSelect}
              className={cn("flex cursor-default select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-base outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover [&_svg]:size-4 [&_svg]:text-text-muted",
                it.danger && "text-danger-text [&_svg]:text-danger-text")}>
              {it.icon}{it.label}
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TT.Provider delayDuration={300}>
      <TT.Root>
        <TT.Trigger asChild>{children}</TT.Trigger>
        <TT.Portal>
          <TT.Content side={side} sideOffset={6} className="z-80 max-w-64 rounded-sm bg-text px-2 py-1 text-xs font-medium text-bg shadow-pop animate-fade-in">
            {content}
          </TT.Content>
        </TT.Portal>
      </TT.Root>
    </TT.Provider>
  );
}

export function Popover({ trigger, children, align = "start", className }: { trigger: React.ReactNode; children: React.ReactNode; align?: "start" | "center" | "end"; className?: string }) {
  return (
    <P.Root>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} sideOffset={6} className={cn("z-40 rounded-lg border border-border bg-surface p-3 shadow-pop animate-pop-in focus:outline-none", className)}>
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
