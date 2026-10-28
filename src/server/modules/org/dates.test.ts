import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./dates";

describe("nextOccurrence", () => {
  it("this year when still ahead (or today), next year when passed", () => {
    expect(nextOccurrence("11-02", "2026-10-29")).toBe("2026-11-02");
    expect(nextOccurrence("10-29", "2026-10-29")).toBe("2026-10-29");
    expect(nextOccurrence("10-28", "2026-10-29")).toBe("2027-10-28");
  });
  it("Feb 29 falls on Feb 28 outside leap years", () => {
    expect(nextOccurrence("02-29", "2026-10-29")).toBe("2027-02-28");
    expect(nextOccurrence("02-29", "2027-10-29")).toBe("2028-02-29");
  });
});
