"use client";
import * as React from "react";
import { Checkbox as C, Switch as Sw, RadioGroup as R } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";

const box = "peer shrink-0 border border-border-input bg-surface transition-colors duration-fast " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 disabled:cursor-not-allowed";

export function Checkbox({ label, className, ...props }: React.ComponentProps<typeof C.Root> & { label?: React.ReactNode }) {
  const id = React.useId();
  const el = (
    <C.Root id={props.id ?? id} {...props}
      className={cn(box, "size-4 rounded-xs data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent text-on-accent", className)}>
      <C.Indicator className="flex items-center justify-center">
        {props.checked === "indeterminate" ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </C.Indicator>
    </C.Root>
  );
  if (!label) return el;
  return (
    <div className="flex items-center gap-2">
      {el}
      <label htmlFor={props.id ?? id} className="text-base text-text peer-disabled:opacity-50">{label}</label>
    </div>
  );
}

export function Switch({ label, className, ...props }: React.ComponentProps<typeof Sw.Root> & { label?: React.ReactNode }) {
  const id = React.useId();
  return (
    <div className="flex items-center gap-2.5">
      <Sw.Root id={props.id ?? id} {...props}
        className={cn(box, "relative h-5 w-9 rounded-pill border-transparent bg-border-strong data-[state=checked]:bg-accent", className)}>
        <Sw.Thumb className="block size-4 translate-x-0.5 rounded-pill bg-white shadow-card transition-transform duration-fast data-[state=checked]:translate-x-[18px]" />
      </Sw.Root>
      {label && <label htmlFor={props.id ?? id} className="text-base text-text">{label}</label>}
    </div>
  );
}

export function RadioGroup({ options, className, ...props }: React.ComponentProps<typeof R.Root> & { options: { value: string; label: React.ReactNode; hint?: React.ReactNode }[] }) {
  const base = React.useId();
  return (
    <R.Root className={cn("flex flex-col gap-2", className)} {...props}>
      {options.map((o) => (
        <div key={o.value} className="flex items-start gap-2">
          <R.Item id={`${base}-${o.value}`} value={o.value}
            className={cn(box, "mt-0.5 size-4 rounded-pill data-[state=checked]:border-accent")}>
            <R.Indicator className="flex items-center justify-center after:block after:size-2 after:rounded-pill after:bg-accent" />
          </R.Item>
          <label htmlFor={`${base}-${o.value}`} className="text-base text-text">
            {o.label}{o.hint && <span className="block text-sm text-text-muted">{o.hint}</span>}
          </label>
        </div>
      ))}
    </R.Root>
  );
}

/** Segmented control for 2–4 mutually exclusive options (e.g. Full day / First half / Second half). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md bg-surface-hover p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cn("h-7 rounded-sm px-3 text-sm font-medium text-text-muted transition-colors duration-fast",
            value === o.value && "bg-surface text-text shadow-card")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
