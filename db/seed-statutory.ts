/**
 * Statutory rates for local development (called from db/seed.ts): loads the global rate tables. The demo company
 * gets no CA verification, so the "unverified rates" banner shows until someone records one on
 * Settings → Payroll → Statutory rates.
 */
import postgres from "postgres";
import { syncStatutoryRates } from "@/server/modules/statutory/service";

export async function seedStatutory(tenantId: string) {
  void tenantId;   // rates are global; nothing tenant-specific to seed
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
  try {
    await admin.begin((tx) => syncStatutoryRates(tx as unknown as postgres.Sql));
  } finally {
    await admin.end();
  }
}
