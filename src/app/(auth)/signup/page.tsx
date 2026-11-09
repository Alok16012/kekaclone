import type { Metadata } from "next";
import { ROOT_DOMAIN } from "@/lib/tenancy";
import { Card } from "@/ui/card";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Create your workspace" };

export default function SignupPage() {
  return (
    <Card className="p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Set up erp for your company</h1>
      <p className="mt-1 mb-6 text-base text-text-muted">People, leave and attendance in one place, ready in a minute.</p>
      <SignupForm rootDomain={ROOT_DOMAIN} />
    </Card>
  );
}
