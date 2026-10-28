import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export const buttonStyles = cva(
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
    "transition-[background-color,border-color,color,box-shadow,transform] duration-fast ease-out-soft " +
    "active:scale-[.98] disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none " +
    "[&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent shadow-card hover:bg-accent-hover",
        secondary: "border border-border-strong bg-surface text-text hover:bg-surface-hover",
        ghost: "text-text hover:bg-surface-hover",
        soft: "bg-accent-soft text-accent-text hover:bg-accent-soft/70",
        danger: "bg-danger text-on-accent shadow-card hover:bg-danger/90",
        link: "h-auto px-0 text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-9 px-4 text-base",
        lg: "h-11 px-5 text-md",
        icon: "size-9",
        "icon-sm": "size-8",
      },
      block: { true: "w-full" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {
  asChild?: boolean;
  loading?: boolean;
}

/** Real <button>. While loading the label stays (screen readers still hear it) and a spinner overlays it. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild, loading, children, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      aria-busy={loading || undefined}
      className={cn(buttonStyles({ variant, size, block }), className)}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          <span className={cn("inline-flex items-center gap-2", loading && "opacity-0")}>{children}</span>
          {loading && <Loader2 aria-hidden className="absolute animate-spin" />}
        </>
      )}
    </Comp>
  );
});

/** Icon-only button: `label` is required and becomes the accessible name + tooltip text. */
export const IconButton = React.forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, size = "icon", variant = "ghost", ...props },
  ref,
) {
  return <Button ref={ref} aria-label={label} title={label} size={size} variant={variant} {...props} />;
});
