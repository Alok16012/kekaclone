/**
 * Writes erp's statutory rate tables (src/server/modules/statutory/rates-data.ts) into the global statutory_rates
 * table. Safe to run any number of times: inserts new versions, updates changed ones, never deletes.
 * Runs as the admin role because the app role can only read that table.
 *   pnpm jobs:statutory-rates
 */
import postgres from "postgres";
import { syncStatutoryRates } from "@/server/modules/statutory/service";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

async function main() {
  const r = await admin.begin((tx) => syncStatutoryRates(tx as unknown as postgres.Sql));
  console.log(`statutory rates: ${r.inserted} added, ${r.updated} updated, ${r.total - r.inserted - r.updated} unchanged. Every rate is UNVERIFIED until a CA checks it.`);
  await admin.end();
}
main().catch(async (e) => { console.error(e); await admin.end(); process.exit(1); });
