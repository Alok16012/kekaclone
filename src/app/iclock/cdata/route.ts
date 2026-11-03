import { admsContext, handshake, pushData } from "../adms";

/**
 * ZKTeco / eSSL ADMS push: GET = handshake (options), POST = data (ATTLOG, OPERLOG …). Public route; the device is
 * identified by the serial (SN) it was registered with. Set the device's "ADMS" / "Cloud server" setting to this host.
 */
export async function GET(req: Request) {
  const ctx = await admsContext(req);
  return ctx instanceof Response ? ctx : handshake(ctx);
}

export async function POST(req: Request) {
  const ctx = await admsContext(req);
  return ctx instanceof Response ? ctx : pushData(req, ctx);
}
