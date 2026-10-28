/* Applies db/migrations/*.sql in order, once each, as the owner role (DATABASE_ADMIN_URL). */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error("DATABASE_ADMIN_URL is not set");
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql`select name from _migrations`).map((r) => r.name as string));
  const dir = join(import.meta.dirname, "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    process.stdout.write(`applying ${f} … `);
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, f), "utf8"));
      await tx`insert into _migrations (name) values (${f})`;
    });
    console.log("done");
  }
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
