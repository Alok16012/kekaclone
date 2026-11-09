import { describe, expect, it } from "vitest";
import { buildZip, crc32, readZip, uniqueNames } from "./zip";

describe("zip", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
    expect(crc32(new Uint8Array())).toBe(0);
  });
  it("round-trips stored entries with unique names", () => {
    const a = new TextEncoder().encode("hello"), b = new TextEncoder().encode("world!");
    const zip = buildZip([{ name: "x.pdf", bytes: a }, { name: "x.pdf", bytes: b }, { name: "../evil/../y.pdf", bytes: a }]);
    expect(zip[0]).toBe(0x50); expect(zip[1]).toBe(0x4b);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(["x.pdf", "x (2).pdf", "y.pdf"]);
    expect(new TextDecoder().decode(back[1].bytes)).toBe("world!");
    // end-of-central-directory record is the last 22 bytes and counts the entries
    const dv = new DataView(zip.buffer, zip.byteLength - 22);
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
    expect(dv.getUint16(10, true)).toBe(3);
  });
  it("uniqueNames handles names without an extension", () => {
    expect(uniqueNames(["a", "a", "A"])).toEqual(["a", "a (2)", "A (3)"]);
  });
});
