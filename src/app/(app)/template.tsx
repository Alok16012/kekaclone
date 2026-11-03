import { Suspense } from "react";
import { AckGate } from "@/features/documents/ack-gate-server";
import { BrandStyle } from "@/features/saas/brand-style";
import { PlanNotice } from "@/features/saas/plan-notice";

/**
 * Wraps every signed-in page (between the (app) layout and the page) without touching the layout.
 * Adds company branding (accent colours), the trial / billing notice for admins, and the policy-acknowledgement gate (S49), each in its own Suspense boundary: the page renders and streams as usual,
 * and if the person has blocking documents to acknowledge, a modal that can't be dismissed covers it.
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}><BrandStyle /></Suspense>
      <Suspense fallback={null}><PlanNotice /></Suspense>
      {children}
      <Suspense fallback={null}><AckGate /></Suspense>
    </>
  );
}
