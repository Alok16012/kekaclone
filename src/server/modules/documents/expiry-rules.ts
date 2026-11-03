/** Document expiry reminders: which reminder (30 or 7 days before) is due today and hasn't been sent. Pure. */
import { fromISO, type ISODate } from "@/lib/dates";

export const REMINDER_DAYS = [30, 7] as const;
export type ReminderKey = "30" | "7";

export const daysUntil = (expiry: ISODate, today: ISODate) => Math.round((fromISO(expiry).getTime() - fromISO(today).getTime()) / 864e5);

/**
 * The reminder to send today: the smallest window the document has entered that wasn't sent yet. A document that
 * is already within 7 days gets the "7" reminder only (no point sending the 30-day one as well); an expired document
 * gets none from the job (it shows in HR's expiring list instead).
 */
export function dueReminder(expiry: ISODate, today: ISODate, sent: Partial<Record<ReminderKey, string>>): ReminderKey | null {
  const left = daysUntil(expiry, today);
  if (left < 0) return null;
  if (left <= 7) return sent["7"] ? null : "7";
  if (left <= 30) return sent["30"] ? null : "30";
  return null;
}

export type ExpiryBucket = "expired" | "week" | "month" | "later";
export function bucket(expiry: ISODate, today: ISODate): ExpiryBucket {
  const left = daysUntil(expiry, today);
  return left < 0 ? "expired" : left <= 7 ? "week" : left <= 30 ? "month" : "later";
}

export function reminderText(docType: string, expiry: ISODate, today: ISODate) {
  const left = daysUntil(expiry, today);
  return left === 0 ? `${docType} expires today` : left === 1 ? `${docType} expires tomorrow` : `${docType} expires in ${left} days`;
}
