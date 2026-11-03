import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/feedback";
import { currentSubdomain, getActor, resolveTenant } from "@/server/auth/session";
import { ssoButtons } from "@/server/modules/auth/oidc";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

async function LoginCard({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h1 className="text-xl font-semibold">We couldn&apos;t find this workspace</h1>
        <p className="mt-2 text-base text-text-muted">Check the address your admin shared, or create a new workspace.</p>
        <Link href="/signup" className="mt-4 inline-block text-base font-medium text-accent-text hover:underline">Create a workspace</Link>
      </Card>
    );
  }
  if (await getActor()) redirect("/home");
  const sp = await searchParams;
  const next = sp.next, ssoError = sp.sso_error;
  const a = tenant.authSettings;
  const sso = ssoButtons(tenant);
  const passwordOn = !(a?.sso_only && sso.length);
  return (
    <Card className="p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to {tenant.name}</h1>
      <p className="mt-1 mb-6 text-base text-text-muted">{tenant.branding?.login_note || (passwordOn ? "Use your work email." : "Use your company account.")}</p>
      <LoginForm next={typeof next === "string" ? next : undefined} sso={sso} password={passwordOn} mobileOtp={!!a?.mobile_otp} ssoError={typeof ssoError === "string" ? ssoError : undefined} />
    </Card>
  );
}

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <Suspense fallback={<Card className="flex flex-col gap-4 p-8"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-11" /></Card>}>
      <LoginCard searchParams={props.searchParams} />
    </Suspense>
  );
}
