import type { Metadata } from "next";
import { Card } from "@/ui/card";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <Card className="p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Forgot your password?</h1>
      <p className="mt-1 mb-6 text-base text-text-muted">Enter your work email and we&apos;ll send you a link to choose a new one.</p>
      <ForgotForm />
    </Card>
  );
}
