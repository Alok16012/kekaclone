import "server-only";
import postgres from "postgres";

declare global { var __erpSql: postgres.Sql | undefined }

/** The app's pool. Connects as erp_app_user (RLS enforced). Reused across hot reloads in dev. */
export const sql: postgres.Sql =
  globalThis.__erpSql ??
  postgres(process.env.DATABASE_URL!, {
    max: 10,
    idle_timeout: 20,
    onnotice: () => {},
    types: { bigint: postgres.BigInt },
  });
if (process.env.NODE_ENV !== "production") globalThis.__erpSql = sql;

export type Tx = postgres.TransactionSql;

/**
 * Every tenant-scoped query runs inside this: one transaction with app.tenant_id set locally,
 * so Postgres RLS only shows that tenant's rows even if a query forgets a where clause.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

export class AppError extends Error {
  constructor(public code: "not_found" | "forbidden" | "invalid" | "conflict" | "unauthenticated", message: string, public field?: string) {
    super(message);
  }
}
