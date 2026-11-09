import "server-only";
import { parseReceipt, scaleConfidence, type ReceiptGuess } from "./parse";

/**
 * Receipt OCR, self-hosted with tesseract.js (WebAssembly Tesseract running inside the Node process; nothing leaves
 * the server). It needs the English language data file on disk: set OCR_LANG_PATH to a directory holding
 * eng.traineddata (or eng.traineddata.gz, from the tessdata project). Without it OCR reports "not configured" and
 * the expense form simply asks the person to type the amount, so a claim is never blocked on OCR.
 */
export type OcrStatus = { configured: true; langPath: string } | { configured: false; reason: string };
export type OcrResult = { ok: true; guess: ReceiptGuess; engineConfidence: number; text: string } | { ok: false; reason: string };

export const OCR_IMAGE_MIMES = new Set(["image/png", "image/jpeg"]);
const TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 40_000);

export function ocrStatus(): OcrStatus {
  const langPath = process.env.OCR_LANG_PATH?.trim();
  if (!langPath) return { configured: false, reason: "OCR_LANG_PATH isn't set (a directory with eng.traineddata). Receipt reading is off; type the amount from the receipt." };
  return { configured: true, langPath };
}

type Worker = { recognize: (img: Uint8Array) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> };

/** Read a receipt image: the raw text, the engine's confidence and erp's guess at amount, date and merchant. Never throws. */
export async function readReceipt(bytes: Uint8Array, mime: string): Promise<OcrResult> {
  const s = ocrStatus();
  if (!s.configured) return { ok: false, reason: s.reason };
  if (!OCR_IMAGE_MIMES.has(mime)) return { ok: false, reason: "Only PNG and JPG receipts can be read. For a PDF, type the amount in." };
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const t = await import("tesseract.js");
    const cachePath = process.env.OCR_CACHE_DIR?.trim() || s.langPath;
    worker = (await t.createWorker("eng", t.OEM.LSTM_ONLY, { langPath: s.langPath, cachePath, gzip: !!process.env.OCR_LANG_GZIP, errorHandler: () => {} })) as unknown as Worker;
    const result = await Promise.race([
      worker.recognize(bytes),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS); }),
    ]);
    const text = result.data.text ?? "", engine = Math.round(result.data.confidence ?? 0);
    if (!text.trim()) return { ok: false, reason: "Nothing readable was found on the receipt. Type the amount in." };
    return { ok: true, guess: scaleConfidence(parseReceipt(text), engine), engineConfidence: engine, text: text.slice(0, 4000) };
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    return { ok: false, reason: m === "timeout" ? "Reading the receipt took too long. Type the amount in." : "The receipt couldn't be read. Type the amount in." };
  } finally {
    if (timer) clearTimeout(timer);
    await worker?.terminate().catch(() => {});
  }
}
