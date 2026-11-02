import "server-only";
import type { Tx } from "@/server/db";
import { newToken, sha256 } from "@/server/auth/password";
import { appUrl } from "@/server/email";

export type TokenKind = "portal" | "self_schedule" | "scorecard";
export type TokenRow = { id: string; kind: TokenKind; candidate_id: string | null; interview_id: string | null; employee_id: string | null; expires_at: Date; used_at: Date | null };

/** A fresh link token; only its hash is stored. Earlier unused links of the same kind for the same target stop working. */
export async function issueToken(tx: Tx, a: { tenantId: string; kind: TokenKind; candidateId?: string | null; interviewId?: string | null; employeeId?: string | null; days: number }) {
  if (a.kind === "portal") await tx`update hire_tokens set expires_at = least(expires_at, now()) where kind = 'portal' and candidate_id = ${a.candidateId ?? null} and expires_at > now()`;
  if (a.kind === "self_schedule") await tx`update hire_tokens set expires_at = least(expires_at, now()) where kind = 'self_schedule' and interview_id = ${a.interviewId ?? null} and expires_at > now()`;
  if (a.kind === "scorecard") await tx`update hire_tokens set expires_at = least(expires_at, now()) where kind = 'scorecard' and interview_id = ${a.interviewId ?? null} and employee_id = ${a.employeeId ?? null} and expires_at > now()`;
  const token = newToken();
  await tx`insert into hire_tokens (tenant_id, kind, token_hash, candidate_id, interview_id, employee_id, expires_at)
           values (${a.tenantId}, ${a.kind}, ${sha256(token)}, ${a.candidateId ?? null}, ${a.interviewId ?? null}, ${a.employeeId ?? null}, now() + make_interval(days => ${a.days}))`;
  return token;
}

/** Looks a token up by hash. Expired tokens never match; used ones match only when `allowUsed` (e.g. to show "already done"). */
export async function findToken(tx: Tx, kind: TokenKind, token: string, opts: { allowUsed?: boolean } = {}): Promise<TokenRow | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const [t] = await tx<TokenRow[]>`
    select id, kind, candidate_id, interview_id, employee_id, expires_at, used_at from hire_tokens
    where token_hash = ${sha256(token)} and kind = ${kind} and expires_at > now() and (${!!opts.allowUsed} or used_at is null)`;
  return t ?? null;
}

export const publicLink = (subdomain: string, kind: TokenKind, token: string) =>
  appUrl(subdomain, kind === "portal" ? `/p/portal/${token}` : kind === "self_schedule" ? `/p/schedule/${token}` : `/p/scorecard/${token}`);
