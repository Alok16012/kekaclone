import { z } from "zod";

/** Profile sections people can edit, the columns behind them, and who needs approval. Pure (shared by client forms and server). */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const opt = (max = 120) => z.string().trim().max(max).nullable().transform((v) => (v === "" ? null : v));
const address = z.object({ line1: opt(200), line2: opt(200), city: opt(80), state: opt(80), pincode: opt(12), country: opt(60) }).partial();

export const SECTIONS = {
  personal: {
    label: "Personal details",
    needsApproval: true,
    schema: z.object({
      dob: date, gender: z.enum(["male", "female", "non_binary", "undisclosed"]).nullable(),
      marital_status: z.enum(["single", "married", "divorced", "widowed", "undisclosed"]).nullable(),
      blood_group: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]).nullable(), nationality: opt(2),
    }).partial(),
  },
  contact: {
    label: "Contact details",
    needsApproval: true,
    schema: z.object({ personal_email: z.email().nullable().or(z.literal("").transform(() => null)), mobile: opt(20) }).partial(),
  },
  addresses: {
    label: "Addresses",
    needsApproval: true,
    schema: z.object({ addresses: z.object({ current: address, permanent: address }).partial() }).partial(),
  },
  about: {
    label: "About",
    needsApproval: false,
    schema: z.object({ bio: z.object({ summary: opt(1000), loveAboutJob: opt(500), hobbies: opt(500) }).partial() }).partial(),
  },
} as const;

export type SectionKey = keyof typeof SECTIONS;
export const isSection = (s: string): s is SectionKey => s in SECTIONS;

export const FIELD_LABELS: Record<string, string> = {
  dob: "Date of birth", gender: "Gender", marital_status: "Marital status", blood_group: "Blood group", nationality: "Nationality",
  personal_email: "Personal email", mobile: "Mobile", addresses: "Addresses", bio: "About",
};
