"use client";
import { Toaster as Sonner } from "sonner";
export { toast } from "sonner";

/** Toasts: bottom-right on desktop, top on mobile; polite live region; undo actions via toast(..., { action }). */
export function Toaster() {
  return (
    <Sonner position="bottom-right" closeButton
      toastOptions={{
        classNames: {
          toast: "!bg-surface !text-text !border !border-border !shadow-pop !rounded-md !font-sans",
          description: "!text-text-muted",
          actionButton: "!bg-accent !text-on-accent",
          success: "[&_[data-icon]]:!text-success", error: "[&_[data-icon]]:!text-danger",
        },
      }} />
  );
}
