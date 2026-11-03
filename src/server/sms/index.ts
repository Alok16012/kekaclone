import "server-only";
import { withTenant, type Tx } from "@/server/db";

/**
 * SMS provider behind one interface. MSG91 when MSG91_AUTH_KEY (+ MSG91_TEMPLATE_ID, MSG91_SENDER) are set;
 * otherwise a "dev SMS" provider that only records the message, visible at /dev/sms. Messages are queued inside
 * the caller's transaction and sent after commit, like email.
 */
export interface SmsProvider {
  readonly name: "msg91" | "dev";
  send(to: string, body: string, vars: Record<string, string>): Promise<{ id: string | null }>;
}

class DevSms implements SmsProvider {
  readonly name = "dev" as const;
  async send(to: string, body: string) {
    if (process.env.NODE_ENV !== "production") console.log(`[sms] ${to} · ${body}`);
    return { id: null };
  }
}

class Msg91 implements SmsProvider {
  readonly name = "msg91" as const;
  constructor(private authKey: string, private templateId: string, private sender: string) {}
  async send(to: string, _body: string, vars: Record<string, string>) {
    // MSG91 "Flow" API: the text comes from the DLT-approved template; we only pass the variables.
    const res = await fetch("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { authkey: this.authKey, "content-type": "application/json" },
      body: JSON.stringify({ template_id: this.templateId, sender: this.sender, short_url: "0", recipients: [{ mobiles: to.replace(/^\+/, ""), ...vars }] }),
    });
    const json = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || json.type === "error") throw new Error(json.message ?? `HTTP ${res.status}`);
    return { id: json.message ?? null };
  }
}

export function smsProvider(): SmsProvider {
  const key = process.env.MSG91_AUTH_KEY?.trim(), tpl = process.env.MSG91_TEMPLATE_ID?.trim(), sender = process.env.MSG91_SENDER?.trim();
  return key && tpl && sender ? new Msg91(key, tpl, sender) : new DevSms();
}

export function smsProviderStatus() {
  const p = smsProvider();
  return { name: p.name, configured: p.name !== "dev", hint: "MSG91_AUTH_KEY, MSG91_TEMPLATE_ID and MSG91_SENDER in .env.local" };
}

/** Indian mobile normalisation: 10 digits (optionally +91 / 0 prefixed) → +91XXXXXXXXXX. Null when it isn't one. */
export function normalizeIndianMobile(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, "");
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(d);
  return m ? `+91${m[1]}` : null;
}

export async function queueSms(tx: Tx, tenantId: string, m: { kind: string; to: string; body: string }) {
  const [r] = await tx<{ id: string }[]>`insert into outbound_sms (tenant_id, kind, to_phone, body) values (${tenantId}, ${m.kind}, ${m.to}, ${m.body}) returning id`;
  return r.id;
}

/** Send this tenant's queued messages (post-commit). The OTP itself is the only variable MSG91 needs. */
export async function deliverQueuedSms(tenantId: string) {
  const provider = smsProvider();
  await withTenant(tenantId, async (tx) => {
    const queued = await tx<{ id: string; to_phone: string; body: string }[]>`
      select id, to_phone, body from outbound_sms where status = 'queued' and attempts < 3 order by created_at limit 20 for update skip locked`;
    for (const m of queued) {
      try {
        const code = /\b(\d{6})\b/.exec(m.body)?.[1] ?? "";
        const r = await provider.send(m.to_phone, m.body, { otp: code });
        await tx`update outbound_sms set status = 'sent', provider = ${provider.name}, provider_id = ${r.id}, sent_at = now(), attempts = attempts + 1 where id = ${m.id}`;
      } catch (e) {
        await tx`update outbound_sms set attempts = attempts + 1, error = ${String((e as Error).message).slice(0, 500)}, status = case when attempts + 1 >= 3 then 'failed' else 'queued' end where id = ${m.id}`;
      }
    }
  });
}
