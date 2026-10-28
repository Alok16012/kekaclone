import * as React from "react";
import { Label as RLabel } from "radix-ui";
import { cn } from "@/lib/cn";

export const controlBase =
  "w-full rounded-md border border-border-input bg-surface text-base text-text placeholder:text-text-placeholder " +
  "transition-[border-color,box-shadow] duration-fast hover:border-text-muted " +
  "focus-visible:outline-none focus-visible:border-focus focus-visible:ring-3 focus-visible:ring-focus/25 " +
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70 " +
  "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/25 read-only:bg-surface-sunken";

export function Label({ className, required, children, ...props }: React.ComponentProps<typeof RLabel.Root> & { required?: boolean }) {
  return (
    <RLabel.Root className={cn("text-sm font-medium text-text", className)} {...props}>
      {children}
      {required && <span aria-hidden className="ml-0.5 text-danger">*</span>}
    </RLabel.Root>
  );
}

type FieldCtx = { id: string; describedBy?: string; invalid: boolean };
const Ctx = React.createContext<FieldCtx | null>(null);
export const useField = () => React.useContext(Ctx);

/** Label + control + help/error, wired with ids so the error is announced with the input. */
export function Field({
  label, help, error, required, children, className,
}: { label?: React.ReactNode; help?: React.ReactNode; error?: React.ReactNode; required?: boolean; children: React.ReactNode; className?: string }) {
  const id = React.useId();
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, helpId].filter(Boolean).join(" ") || undefined;
  return (
    <Ctx.Provider value={{ id, describedBy, invalid: !!error }}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        {label && <Label htmlFor={id} required={required}>{label}</Label>}
        {children}
        {error ? (
          <p id={errId} role="alert" className="text-sm text-danger-text">{error}</p>
        ) : help ? (
          <p id={helpId} className="text-sm text-text-muted">{help}</p>
        ) : null}
      </div>
    </Ctx.Provider>
  );
}

function useControlProps(props: { id?: string; "aria-describedby"?: string; "aria-invalid"?: React.AriaAttributes["aria-invalid"] }) {
  const f = useField();
  return {
    id: props.id ?? f?.id,
    "aria-describedby": props["aria-describedby"] ?? f?.describedBy,
    "aria-invalid": props["aria-invalid"] ?? (f?.invalid || undefined),
  };
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { leading?: React.ReactNode; trailing?: React.ReactNode; inputSize?: "sm" | "md" | "lg" }>(
  function Input({ className, leading, trailing, inputSize = "md", ...props }, ref) {
    const a = useControlProps(props);
    const h = { sm: "h-8", md: "h-9", lg: "h-11" }[inputSize];
    const input = (
      <input ref={ref} {...props} {...a}
        className={cn(controlBase, h, "px-3", leading && "pl-9", trailing && "pr-9", props.type === "number" && "tabular", className)} />
    );
    if (!leading && !trailing) return input;
    return (
      <div className="relative">
        {leading && <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted [&_svg]:size-4">{leading}</span>}
        {input}
        {trailing && <span className="absolute inset-y-0 right-3 flex items-center text-text-muted [&_svg]:size-4">{trailing}</span>}
      </div>
    );
  },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  const a = useControlProps(props);
  return <textarea ref={ref} rows={3} {...props} {...a} className={cn(controlBase, "min-h-20 px-3 py-2", className)} />;
});

/** ₹ amount input: shows grouped Indian format, stores paise as an integer. */
export function MoneyInput({ valuePaise, onChangePaise, ...props }: { valuePaise: number | null; onChangePaise: (p: number | null) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = React.useState(valuePaise == null ? "" : formatINR(valuePaise, { symbol: false }));
  return (
    <Input inputMode="decimal" leading={<span className="text-sm">₹</span>} value={text}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d.]/g, "");
        setText(e.target.value);
        onChangePaise(raw === "" ? null : Math.round(parseFloat(raw) * 100));
      }}
      onBlur={() => setText(valuePaise == null ? "" : formatINR(valuePaise, { symbol: false }))}
      className="tabular" {...props} />
  );
}

export function formatINR(paise: number, { symbol = true, decimals = 2 }: { symbol?: boolean; decimals?: number } = {}) {
  return new Intl.NumberFormat("en-IN", {
    style: symbol ? "currency" : "decimal", currency: "INR",
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(paise / 100);
}
