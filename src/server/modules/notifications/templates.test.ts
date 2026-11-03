import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, defaultTemplate, isTemplateEvent, renderTemplate, SAMPLE_VARS, validateTemplate } from "./templates";

describe("notification email templates", () => {
  it("renders placeholders into a subject and paragraphs", () => {
    const r = renderTemplate({ subject: "{{title}} · {{company}}", body: "Hi {{first_name}},\n\n{{body}}\n\n\nSee {{link}}" }, SAMPLE_VARS);
    expect(r.subject).toBe("Your request was approved · Acme Technologies");
    expect(r.paragraphs).toEqual(["Hi Asha,", "Casual leave · 12 Nov – 13 Nov (2 days)", "See https://acme.erp.app/me/leave"]);
  });
  it("never renders an empty subject or body", () => {
    const r = renderTemplate({ subject: "{{nope}}", body: "{{nope}}" }, SAMPLE_VARS);
    expect(r.subject).toBe("Your request was approved · Acme Technologies");
    expect(r.paragraphs).toEqual([SAMPLE_VARS.body]);
  });
  it("falls back to the shared default for events without a special template", () => {
    expect(defaultTemplate("leave.fyi")).toEqual(DEFAULT_TEMPLATE);
    expect(defaultTemplate("approval.pending").subject).toMatch(/Waiting/);
    expect(isTemplateEvent("request.approved")).toBe(true);
    expect(isTemplateEvent("approvals.digest")).toBe(false);
    expect(isTemplateEvent("made.up")).toBe(false);
  });
  it("validates subject, body length and placeholders", () => {
    expect(validateTemplate({ subject: "", body: "x" })).toMatchObject({ ok: false, field: "subject" });
    expect(validateTemplate({ subject: "x", body: " " })).toMatchObject({ ok: false, field: "body" });
    expect(validateTemplate({ subject: "x", body: "Hi {{surname}}" })).toMatchObject({ ok: false, message: expect.stringContaining("surname") });
    expect(validateTemplate({ subject: "x", body: "y".repeat(4001) })).toMatchObject({ ok: false });
    expect(validateTemplate({ subject: " Hello {{first_name}} ", body: "Hi\r\n\r\n{{body}}" })).toEqual({ ok: true, value: { subject: "Hello {{first_name}}", body: "Hi\n\n{{body}}" } });
  });
});
