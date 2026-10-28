import { PageHeader } from "@/ui/app-shell";
import { SettingsNav } from "@/features/settings/settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <PageHeader title="Settings" description="How your company is set up in erp." />
      <div className="flex flex-col gap-6 lg:flex-row">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </>
  );
}
