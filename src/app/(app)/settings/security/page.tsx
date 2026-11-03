import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { can } from "@/server/auth/permissions";
import { securitySettings } from "@/server/modules/settings/security";
import { SecuritySettings } from "@/features/settings/security-ui";
import { SignInMethods } from "@/features/settings/signin-methods";

export const metadata: Metadata = { title: "Sign-in security" };

export default async function SecurityPage() {
  const d = await load(async (tx, actor) => ({ ...(await securitySettings(tx, actor)), canEdit: can(actor, "settings.security") }));
  return (
    <div className="flex flex-col gap-4">
      <SecuritySettings mode={d.mode} mine={d.mine} canEdit={d.canEdit} />
      <SignInMethods canEdit={d.canEdit} sessionHours={d.sessionHours} ipAllowlist={d.ipAllowlist} sso={d.sso} mobileOtp={d.mobileOtp} features={d.features} />
    </div>
  );
}
