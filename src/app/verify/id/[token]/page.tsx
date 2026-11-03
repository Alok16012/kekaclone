import type { Metadata } from "next";
import { Suspense } from "react";
import { BadgeCheck, ShieldX } from "lucide-react";
import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { verifiedCard, verifySecret } from "@/server/modules/corehr/people";
import { verifyIdCardToken } from "@/server/modules/corehr/id-token";
import { Card } from "@/ui/card";
import { Skeleton } from "@/ui/feedback";

export const metadata: Metadata = { title: "Verify an ID card", robots: { index: false, follow: false } };

/**
 * Public (no sign-in): the page an ID-card QR opens. The tenant comes from the subdomain only, the token is an HMAC
 * bound to that tenant and person, and the answer is limited to name, title, number and whether they work here now.
 */
async function Result({ params }: { params: PageProps<"/verify/id/[token]">["params"] }) {
  const { token } = await params;
  const tenant = await resolveTenant(await currentSubdomain());
  const id = tenant && typeof token === "string" && token.length < 120 ? verifyIdCardToken(verifySecret(), tenant.id, decodeURIComponent(token)) : null;
  const card = tenant && id ? await withTenant(tenant.id, (tx) => verifiedCard(tx, id)) : null;
  if (!card) {
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <ShieldX className="size-10 text-danger-text" aria-hidden />
        <h1 className="text-xl font-semibold">This ID card can&apos;t be verified</h1>
        <p className="text-base text-text-muted">The code is not valid for this company. Ask the person for another form of ID.</p>
      </Card>
    );
  }
  const current = card.status === "active" || card.status === "notice";
  return (
    <Card className="flex flex-col items-center gap-3 p-8 text-center">
      {current ? <BadgeCheck className="size-10 text-success-text" aria-hidden /> : <ShieldX className="size-10 text-warning-text" aria-hidden />}
      <h1 className="text-xl font-semibold">{card.display_name}</h1>
      <p className="text-base text-text-muted">{card.designation ?? "—"} · {card.company}</p>
      <p className="text-sm text-text-muted">Employee no. <span className="tabular">{card.employee_number}</span></p>
      <p className={current ? "font-medium text-success-text" : "font-medium text-warning-text"}>{current ? "Currently works here" : "No longer works here"}</p>
    </Card>
  );
}

export default function VerifyIdPage(props: PageProps<"/verify/id/[token]">) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        <Suspense fallback={<Card className="flex flex-col items-center gap-3 p-8"><Skeleton className="size-10 rounded-pill" /><Skeleton className="h-6 w-1/2" /><Skeleton className="h-4 w-2/3" /></Card>}>
          <Result params={props.params} />
        </Suspense>
      </div>
    </main>
  );
}
