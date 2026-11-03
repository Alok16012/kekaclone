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

/** The company's sign-in background image, if one was uploaded (fixed behind the page, dimmed so the card stays readable). */
export async function BrandBackground() {
  const tenant = await resolveTenant(await currentSubdomain());
  const id = tenant?.branding?.login_bg_file_id;
  if (!id) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center" style={{ backgroundImage: `url(/brand/background?v=${id.slice(0, 8)})` }}>
      <div className="absolute inset-0 bg-canvas/70" />
    </div>
  );
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
