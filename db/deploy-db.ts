/**
 * One-time setup of a hosted database + object store, run from a laptop with the production values in .env.deploy:
 *   pnpm deploy:db            migrate → set the app role's password → create the storage bucket → seed the demo tenant
 *   pnpm deploy:db -- --no-seed   skip the demo seed (real customer install)
 * Needs: DATABASE_ADMIN_URL (owner, session-mode), DATABASE_URL (app role), ERP_APP_DB_PASSWORD, and for files
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The seed reads the rest like the app does (ERP_DATA_KEY, ROOT_DOMAIN …).
 */
import { spawnSync } from "node:child_process";
import postgres from "postgres";

function run(file: string) {
  const r = spawnSync("pnpm", ["exec", "tsx", "--conditions=react-server", "--tsconfig", "tsconfig.json", file], { stdio: "inherit", env: process.env });
  if (r.status !== 0) throw new Error(`${file} failed`);
}

async function main() {
  for (const k of ["DATABASE_ADMIN_URL", "DATABASE_URL", "ERP_APP_DB_PASSWORD", "ERP_DATA_KEY"]) if (!process.env[k]) throw new Error(`${k} is not set (put it in .env.deploy)`);
  console.log("1/4 migrations");
  run("db/migrate.ts");

  console.log("2/4 app role password");
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });
  await admin.unsafe(`alter role erp_app_user with login password '${process.env.ERP_APP_DB_PASSWORD!.replace(/'/g, "''")}'`);
  await admin.end();

  console.log("3/4 storage bucket");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { SupabaseStorage } = await import("@/server/storage/supabase");
    const created = await new SupabaseStorage(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.SUPABASE_BUCKET || undefined).ensureBucket();
    console.log(created ? "  bucket created" : "  bucket already there");
  } else console.log("  SUPABASE_URL not set: files stay on local disk (not suitable for serverless hosts)");

  if (process.argv.includes("--no-seed")) { console.log("4/4 seed skipped"); return; }
  console.log("4/4 demo seed");
  run("db/seed.ts");
}

main().catch((e) => { console.error(e); process.exit(1); });
