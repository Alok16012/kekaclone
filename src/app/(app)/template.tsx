import { Suspense } from "react";
import { AckGate } from "@/features/documents/ack-gate-server";

/**
 * Wraps every signed-in page (between the (app) layout and the page) without touching the layout.
 * Adds the policy-acknowledgement gate (S49) in its own Suspense boundary: the page renders and streams as usual,
 * and if the person has blocking documents to acknowledge, a modal that can't be dismissed covers it.
 */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={null}><AckGate /></Suspense>
    </>
  );
}
