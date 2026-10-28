import Link from "next/link";
import { Button } from "@/ui/button";

export default function Landing() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-canvas px-6 text-center">
      <span aria-hidden className="flex size-12 items-center justify-center rounded-lg bg-accent text-xl font-bold text-on-accent">e</span>
      <h1 className="max-w-xl text-display font-bold tracking-tight">People, leave and attendance in one place</h1>
      <p className="max-w-md text-md text-text-muted">erp gives every employee one simple home for clocking in, applying for leave and getting answers, and gives HR the tools to run it.</p>
      <Button asChild size="lg"><Link href="/signup">Start free for 30 days</Link></Button>
    </main>
  );
}
