import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { canManageFields, listDefs } from "@/server/modules/corehr/custom-fields";
import { CustomFieldsSettings } from "@/features/corehr/custom-fields-settings";

export const metadata: Metadata = { title: "Custom fields" };

export default async function CustomFieldsPage() {
  const defs = await load(async (tx, actor) => {
    if (!canManageFields(actor)) throw new AppError("forbidden", "You don't have access to custom fields.");
    return tx<Awaited<ReturnType<typeof listDefs>>>`select id, key, label, section, type, options, required, view_roles, edit_roles, position, status from custom_field_defs where entity = 'employee' order by status = 'archived', section, position, label`;
  });
  return <CustomFieldsSettings defs={[...defs]} />;
}
