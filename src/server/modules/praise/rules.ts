/** Word-wrap for the certificate: fits words into lines of a given width, at most `maxLines` (last one ends with …). Pure. */
export function wrapWords(text: string, width: (s: string) => number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (width(next) <= maxWidth || !cur) { cur = next; continue; }
    lines.push(cur); cur = w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && width(last + "…") > maxWidth) last = last.split(" ").slice(0, -1).join(" ");
  kept[maxLines - 1] = (last || kept[maxLines - 1]) + "…";
  return kept;
}
