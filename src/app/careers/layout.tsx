import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: true, follow: true } };

/** Public careers pages: no app chrome, no sign-in. */
export default function CareersLayout({ children }: LayoutProps<"/careers">) {
  return <div className="min-h-dvh bg-canvas"><div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">{children}</div></div>;
}
