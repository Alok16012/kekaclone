import "server-only";
import type { Storage } from "./index";

/**
 * Supabase Storage (S3-compatible object store) through its REST API, with the service-role key: the bucket is private
 * and the app streams bytes itself (/files/[id] checks permissions first). No SDK needed for three calls.
 *   SUPABASE_URL=https://<ref>.supabase.co  SUPABASE_SERVICE_ROLE_KEY=…  SUPABASE_BUCKET=erp-files (default)
 */
export class SupabaseStorage implements Storage {
  constructor(private url: string, private key: string, private bucket = "erp-files") {}
  private endpoint(key: string) {
    if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(key) || key.includes("..")) throw new Error("bad storage key");
    return `${this.url.replace(/\/$/, "")}/storage/v1/object/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }
  async put(key: string, bytes: Uint8Array, mime: string) {
    const r = await fetch(this.endpoint(key), { method: "POST", headers: this.headers({ "content-type": mime || "application/octet-stream", "x-upsert": "false" }), body: bytes as BodyInit });
    if (!r.ok) throw new Error(`storage put failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
  async get(key: string) {
    const r = await fetch(this.endpoint(key), { headers: this.headers(), cache: "no-store" });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`storage get failed (${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async remove(key: string) {
    const r = await fetch(this.endpoint(key), { method: "DELETE", headers: this.headers() });
    if (!r.ok && r.status !== 404 && r.status !== 400) throw new Error(`storage remove failed (${r.status})`);
  }
  /** Create the private bucket if it is missing (deploy script). */
  async ensureBucket() {
    const base = `${this.url.replace(/\/$/, "")}/storage/v1/bucket`;
    const have = await fetch(`${base}/${this.bucket}`, { headers: this.headers() });
    if (have.ok) return false;
    const r = await fetch(base, { method: "POST", headers: this.headers({ "content-type": "application/json" }), body: JSON.stringify({ id: this.bucket, name: this.bucket, public: false, file_size_limit: 26 * 1024 * 1024 }) });
    if (!r.ok) throw new Error(`bucket create failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return true;
  }
}
