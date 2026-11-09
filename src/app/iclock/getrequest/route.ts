import { withTenant } from "@/server/db";
import { touchDevice } from "@/server/modules/attendance/devices";
import { admsContext, text } from "../adms";

/** The device polls here for commands. erp never sends any (it only receives logs), so the answer is always "OK". */
export async function GET(req: Request) {
  const ctx = await admsContext(req);
  if (ctx instanceof Response) return ctx;
  await withTenant(ctx.tenantId, (tx) => touchDevice(tx, ctx.device.id));
  return text("OK");
}
