import type { Metadata } from "next";
import { WifiOff } from "lucide-react";

export const metadata: Metadata = { title: "You're offline" };

/** Served by the service worker when a page can't be fetched. Static: no session, no tenant data. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <WifiOff className="size-10 text-text-muted" aria-hidden />
      <h1 className="text-2xl font-semibold tracking-tight">You&apos;re offline</h1>
      <p className="max-w-sm text-base text-text-muted">erp needs a connection to show your data. Check Wi-Fi or mobile data and try again; clock-ins and requests are only saved once you&apos;re back online.</p>
      <a href="/home" className="rounded-md bg-accent px-4 py-2 text-base font-medium text-on-accent">Try again</a>
    </main>
  );
}
