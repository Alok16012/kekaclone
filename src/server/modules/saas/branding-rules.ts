/**
 * Company branding rules: accent colour validation with a WCAG contrast check (white text on the accent must reach
 * 4.5:1, and the accent must be visible on white/dark surfaces), plus the CSS overrides the app applies. Pure.
 */

export type BrandingInput = { accent?: string | null; accent_dark?: string | null; logo_file_id?: string | null; login_note?: string | null };

export const HEX = /^#([0-9a-f]{6})$/i;

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const chan = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
export function luminance([r, g, b]: [number, number, number]) { return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b); }
export function contrast(a: [number, number, number], b: [number, number, number]) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const WHITE: [number, number, number] = [255, 255, 255];
const DARK_SURFACE: [number, number, number] = [0x15, 0x19, 0x20];

/** Why a hex colour can't be the accent (null = fine). Buttons show white text on it, so 4.5:1 against white is required. */
export function accentProblem(hex: string, mode: "light" | "dark" = "light"): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return "Use a 6-digit hex colour like #2f5bea.";
  const onWhite = contrast(rgb, WHITE);
  if (onWhite < 4.5) return `White text on this colour has ${onWhite.toFixed(1)}:1 contrast; it needs at least 4.5:1. Pick a darker shade.`;
  if (mode === "dark" && contrast(rgb, DARK_SURFACE) < 3) return "This colour almost disappears on dark backgrounds. Pick a lighter shade for dark mode.";
  return null;
}

const mix = (rgb: [number, number, number], to: [number, number, number], t: number): [number, number, number] =>
  [Math.round(rgb[0] + (to[0] - rgb[0]) * t), Math.round(rgb[1] + (to[1] - rgb[1]) * t), Math.round(rgb[2] + (to[2] - rgb[2]) * t)];
const toHex = (rgb: [number, number, number]) => "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");

/** Derived palette for one accent: hover (darker), soft background, readable text shade. */
export function derivePalette(hex: string, mode: "light" | "dark") {
  const rgb = hexToRgb(hex)!;
  if (mode === "light") {
    let text = rgb;
    while (contrast(text, WHITE) < 4.5) text = mix(text, [0, 0, 0], 0.15);
    return { accent: toHex(rgb), hover: toHex(mix(rgb, [0, 0, 0], 0.18)), soft: toHex(mix(rgb, WHITE, 0.88)), text: toHex(text) };
  }
  let text = mix(rgb, WHITE, 0.55);
  while (contrast(text, DARK_SURFACE) < 4.5) text = mix(text, WHITE, 0.15);
  return { accent: toHex(rgb), hover: toHex(mix(rgb, [0, 0, 0], 0.12)), soft: toHex(mix(rgb, DARK_SURFACE, 0.78)), text: toHex(text) };
}

/** The CSS the app injects for a tenant: variable overrides for light and dark themes. Empty when nothing is set. */
export function brandingCss(b: BrandingInput | null | undefined) {
  if (!b?.accent || accentProblem(b.accent)) return "";
  const light = derivePalette(b.accent, "light");
  const darkHex = b.accent_dark && !accentProblem(b.accent_dark, "dark") ? b.accent_dark : b.accent;
  const dark = derivePalette(darkHex, "dark");
  const vars = (p: ReturnType<typeof derivePalette>) => `--accent:${p.accent};--accent-hover:${p.hover};--accent-soft:${p.soft};--accent-text:${p.text};--focus:${p.accent};--sidebar-active:${p.soft};--sidebar-active-text:${p.text};`;
  return `:root{${vars(light)}}:root[data-theme="dark"]{${vars(dark)}}`;
}

export const LOGO_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const LOGO_MAX_BYTES = 512 * 1024;

export function loginNoteProblem(note: string) {
  if (note.length > 200) return "Keep the sign-in note under 200 characters.";
  return null;
}
