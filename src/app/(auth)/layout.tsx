import { Suspense } from "react";
import { BrandMark, BrandStyle } from "@/features/saas/brand-style";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <Suspense fallback={null}><BrandStyle /></Suspense>
      <div className="mb-8">
        <Suspense fallback={<span aria-hidden className="flex size-9 rounded-md bg-surface-hover" />}><BrandMark /></Suspense>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
