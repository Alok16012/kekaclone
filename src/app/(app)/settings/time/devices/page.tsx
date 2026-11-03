import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canManagePolicies } from "@/server/modules/attendance/policies";
import { listDevices } from "@/server/modules/attendance/devices";
import { DevicesSettings } from "@/features/attendance/settings/devices-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Devices" };

export default async function DevicesPage() {
  const d = await load(async (tx, actor) => {
    if (!canManagePolicies(actor)) return null;   // device keys are company-wide secrets
    const [rows, locations] = await Promise.all([listDevices(tx, todayIn()), tx<{ id: string; name: string }[]>`select id, name from locations order by name`]);
    return { rows, locations, host: `${actor.tenant.subdomain}.${process.env.ROOT_DOMAIN ?? "erp.app"}` };
  });
  return d ? <DevicesSettings rows={d.rows} locations={d.locations} host={d.host} /> : <NoAccess />;
}
