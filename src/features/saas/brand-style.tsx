import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { brandingCss } from "@/server/modules/saas/branding-rules";

/**
 * Tenant branding as CSS variable overrides (accent colours). Server component; reads only the public tenant
 * lookup, so it is safe on the sign-in page. Renders nothing when the company hasn't set an accent.
 */
export async function BrandStyle() {
  const tenant = await resolveTenant(await currentSubdomain());
  const css = brandingCss(tenant?.branding);
  if (!css) return null;
  return <style data-brand="accent" dangerouslySetInnerHTML={{ __html: css }} />;
}

/** The company's logo (or erp's mark) for the sign-in page. */
export async function BrandMark({ className = "" }: { className?: string }) {
  const tenant = await resolveTenant(await currentSubdomain());
  if (tenant?.branding?.logo_file_id) {
    // eslint-disable-next-line @next/next/no-img-element -- tenant-uploaded file served by our own route
    return <img src={`/brand/logo?v=${tenant.branding.logo_file_id.slice(0, 8)}`} alt={tenant.name} className={`max-h-12 max-w-48 object-contain ${className}`} />;
  }
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span aria-hidden className="flex size-9 items-center justify-center rounded-md bg-accent text-md font-bold text-on-accent">e</span>
      <span className="text-xl font-semibold">erp</span>
    </span>
  );
}
