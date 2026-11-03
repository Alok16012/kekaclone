import type { Metadata } from "next";

// links in these pages carry a secret token: keep them out of search engines and referrer headers
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function PublicLinkLayout({ children }: LayoutProps<"/p">) {
  return <div className="min-h-dvh bg-canvas"><div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">{children}</div></div>;
}
