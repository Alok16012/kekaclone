import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/feedback";
import { redirect } from "next/navigation";
import { currentSubdomain, getActor, resolveTenant } from "@/server/auth/session";
import { tokenInfo } from "@/server/modules/auth/flows";
import { SetPasswordForm } from "../../set-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

async function Body({ searchParams }: { searchParams: PageProps<"/auth/reset">["searchParams"] }) {
  const t = (await searchParams).t;
  const tenant = await resolveTenant(await currentSubdomain());
  const info = tenant && typeof t === "string" ? await tokenInfo(tenant, t, "reset_password") : null;
  // just used successfully: setting the session re-renders this page, so send the signed-in person on
  if (!info && (await getActor())) redirect("/home");
  if (!tenant || !info || typeof t !== "string") {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h1 className="text-xl font-semibold">This link doesn&apos;t work anymore</h1>
        <p className="mt-2 text-base text-text-muted">Reset links expire after an hour or once used.</p>
        <Link href="/forgot-password" className="mt-4 inline-block text-base font-medium text-accent-text hover:underline">Request a new link</Link>
      </Card>
    );
  }
  return (
    <Card className="p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 mb-6 text-base text-text-muted">{info.name} · {info.email}</p>
      <SetPasswordForm token={t} purpose="reset_password" email={info.email} />
    </Card>
  );
}

export default function Page(props: PageProps<"/auth/reset">) {
  return (
    <Suspense fallback={<Card className="flex flex-col gap-4 p-8"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-11" /></Card>}>
      <Body searchParams={props.searchParams} />
    </Suspense>
  );
}
