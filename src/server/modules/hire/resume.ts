import { inflateSync } from "node:zlib";
import { parseResumeText, pdfStreamText, type Parsed } from "./rules";

const MAX_STREAMS = 200, MAX_TEXT = 20_000;

/**
 * Basic text extraction: plain text files as is; PDFs by reading their content streams (inflating FlateDecode ones)
 * and collecting the strings drawn with text operators. Scanned or unusually encoded PDFs yield little or nothing,
 * which is fine: parsing only pre-fills the form. Word files aren't read.
 */
export function extractResumeText(name: string, bytes: Uint8Array): string {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "txt") return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, MAX_TEXT);
  if (ext !== "pdf") return "";
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [];
  const re = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(raw)) && n++ < MAX_STREAMS) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const dict = m[1];
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Length1|\/FontFile/.test(dict)) continue;
    let body = Buffer.from(raw.slice(start, end), "latin1");
    if (/\/FlateDecode/.test(dict)) {
      try { body = inflateSync(body, { maxOutputLength: 4 * 1024 * 1024 }); } catch { continue; }
    } else if (/\/Filter/.test(dict)) continue;
    const text = pdfStreamText(body.toString("latin1"));
    if (text.trim()) parts.push(text);
    if (parts.join("\n").length > MAX_TEXT) break;
    re.lastIndex = end;
  }
  return parts.join("\n").slice(0, MAX_TEXT);
}

export function parseResume(name: string, bytes: Uint8Array): Parsed & { text: string } {
  const text = extractResumeText(name, bytes);
  return { ...parseResumeText(text), text };
}
