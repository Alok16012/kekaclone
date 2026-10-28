export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="mb-8 flex items-center gap-2.5">
        <span aria-hidden className="flex size-9 items-center justify-center rounded-md bg-accent text-md font-bold text-on-accent">e</span>
        <span className="text-xl font-semibold">erp</span>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
