import "server-only";

/**
 * Calendar sync for interviews (Google Calendar / Microsoft 365) sits behind this interface. Neither is wired up
 * until its OAuth keys are in .env.local; until then interviews still work, panelists get an email and an in-app
 * notification, and anyone on the job can download a calendar file (.ics) from the candidate's Interviews tab.
 */
export interface CalendarProvider {
  name: "google" | "microsoft";
  createEvent(e: { title: string; start: Date; end: Date; attendees: string[]; description: string; location: string | null }): Promise<{ id: string }>;
  cancelEvent(id: string): Promise<void>;
}

export function calendarStatus(): { configured: boolean; provider: string | null; missing: string[] } {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) return { configured: true, provider: "Google Calendar", missing: [] };
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) return { configured: true, provider: "Microsoft 365", missing: [] };
  return { configured: false, provider: null, missing: ["GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET", "or MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET"] };
}

/** No provider ships yet: events are only created once the OAuth connection flow is built on top of these keys. */
export function calendarProvider(): CalendarProvider | null {
  return null;
}
