"use client";
import * as React from "react";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, Switch } from "@/ui/choice";
import type { CustomFieldType, FieldValue } from "@/server/modules/corehr/rules";

export type FieldSpec = { key: string; label: string; type: CustomFieldType; options: string[] | null; required: boolean };

/** One custom field as a form control. Values stay in their stored shape (string, number, boolean, string[]). */
export function CustomFieldInput({ f, value, onChange, error }: { f: FieldSpec; value: FieldValue | undefined; onChange: (v: FieldValue) => void; error?: string }) {
  const text = value == null ? "" : String(value);
  const control = (() => {
    switch (f.type) {
      case "long_text": return <Textarea value={text} onChange={(e) => onChange(e.target.value)} maxLength={2000} />;
      case "number": return <Input type="number" inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
      case "date": return <Input type="date" value={text} onChange={(e) => onChange(e.target.value || null)} />;
      case "email": return <Input type="email" value={text} onChange={(e) => onChange(e.target.value)} />;
      case "phone": return <Input type="tel" value={text} onChange={(e) => onChange(e.target.value)} />;
      case "select": return <Select value={text || undefined} onValueChange={(v) => onChange(v)} options={[...(!f.required ? [{ value: "__none", label: "—" }] : []), ...(f.options ?? []).map((o) => ({ value: o, label: o }))]} placeholder="Choose" />;
      case "boolean": return <Switch checked={value === true} onCheckedChange={(c) => onChange(!!c)} label={value === true ? "Yes" : "No"} />;
      case "multi_select": {
        const arr = Array.isArray(value) ? value : [];
        return (
          <div role="group" aria-label={f.label} className="flex flex-wrap gap-x-4 gap-y-2">
            {(f.options ?? []).map((o) => <Checkbox key={o} label={o} checked={arr.includes(o)} onCheckedChange={(c) => onChange(c ? [...arr, o] : arr.filter((x) => x !== o))} />)}
          </div>
        );
      }
      default: return <Input value={text} onChange={(e) => onChange(e.target.value)} maxLength={200} />;
    }
  })();
  return <Field label={f.label} required={f.required} error={error}>{control}</Field>;
}

/** "__none" from the optional dropdown means cleared. */
export const normaliseFieldValues = (v: Record<string, FieldValue>) =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === "__none" || x === "" ? null : x]));
