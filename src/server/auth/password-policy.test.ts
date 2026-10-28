import { describe, expect, it } from "vitest";
import { passwordProblem } from "./password-policy";

describe("passwordProblem", () => {
  it("accepts a long phrase", () => expect(passwordProblem("monsoon chai at 4pm", "asha@acme.test")).toBeNull());
  it("rejects short, repeated, common and email-based passwords", () => {
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/repeat/);
    expect(passwordProblem("Password123")).toMatch(/common/);
    expect(passwordProblem("rohan.mehta2026", "rohan.mehta@acme.test")).toMatch(/email/);
  });
});
