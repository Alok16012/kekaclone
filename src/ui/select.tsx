"use client";
import * as React from "react";
import { Select as S } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { controlBase, useField } from "./field";

export type Option = { value: string; label: React.ReactNode; disabled?: boolean };

/** Single select (Radix): typeahead, arrow keys, Esc; announces as a combobox. */
export function Select({
  options, value, defaultValue, onValueChange, placeholder = "Select…", disabled, className, size = "md", name,
}: { options: Option[]; value?: string; defaultValue?: string; onValueChange?: (v: string) => void; placeholder?: string; disabled?: boolean; className?: string; size?: "sm" | "md" | "lg"; name?: string }) {
  const f = useField();
  return (
    <S.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled} name={name}>
      <S.Trigger id={f?.id} aria-describedby={f?.describedBy} aria-invalid={f?.invalid || undefined}
        className={cn(controlBase, { sm: "h-8", md: "h-9", lg: "h-11" }[size], "flex items-center justify-between gap-2 px-3 text-left data-[placeholder]:text-text-placeholder", className)}>
        <S.Value placeholder={placeholder} />
        <S.Icon><ChevronDown className="size-4 text-text-muted" /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4}
          className="z-40 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border bg-surface shadow-pop animate-pop-in">
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item key={o.value} value={o.value} disabled={o.disabled}
                className="relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-3 text-base outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover">
                <S.ItemIndicator className="absolute left-2"><Check className="size-4 text-accent-text" /></S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
