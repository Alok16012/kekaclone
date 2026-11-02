import { describe, expect, it } from "vitest";
import { hostOf, validateQuickLink, MAX_QUICK_LINKS } from "./rules";

describe("quick links", () => {
  it("allows up to 18", () => expect(MAX_QUICK_LINKS).toBe(18));
  it("accepts web links and adds https when missing", () => {
    expect(validateQuickLink({ label: " Wiki ", url: "https://wiki.acme.in/start" })).toEqual({ ok: true, label: "Wiki", url: "https://wiki.acme.in/start" });
    expect(validateQuickLink({ label: "Mail", url: "mail.google.com" })).toMatchObject({ ok: true, url: "https://mail.google.com/" });
  });
  it("refuses scripts, other schemes, credentials and junk", () => {
    expect(validateQuickLink({ label: "x", url: "javascript:alert(1)" })).toMatchObject({ ok: false, field: "url" });
    expect(validateQuickLink({ label: "x", url: "data:text/html,hi" })).toMatchObject({ ok: false, field: "url" });
    expect(validateQuickLink({ label: "x", url: "ftp://files.acme.in" })).toMatchObject({ ok: false, field: "url" });
    expect(validateQuickLink({ label: "x", url: "https://me:pw@acme.in" })).toMatchObject({ ok: false, field: "url" });
    expect(validateQuickLink({ label: "x", url: "intranet" })).toMatchObject({ ok: false, field: "url" });
    expect(validateQuickLink({ label: " ", url: "https://acme.in" })).toMatchObject({ ok: false, field: "label" });
    expect(validateQuickLink({ label: "x".repeat(41), url: "https://acme.in" })).toMatchObject({ ok: false, field: "label" });
  });
  it("shows the host", () => expect(hostOf("https://www.acme.in/a")).toBe("acme.in"));
});
