/** Rupee formatting for server code (emails, PDFs, CSV) without pulling in UI modules. Paise in, "₹1,23,456.00" out. */
export function formatINR(paise: number, { symbol = true, decimals = 2 }: { symbol?: boolean; decimals?: number } = {}) {
  const n = paise / 100;
  const s = new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(n));
  return `${n < 0 ? "-" : ""}${symbol ? "₹" : ""}${s}`;
}
