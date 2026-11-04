import { admsContext, text } from "../adms";

/** Command results from the device. erp sends no commands, so there is nothing to record; acknowledge so the device moves on. */
export async function POST(req: Request) {
  const ctx = await admsContext(req);
  return ctx instanceof Response ? ctx : text("OK");
}
