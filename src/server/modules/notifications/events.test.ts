import { describe, expect, it } from "vitest";
import { ALL_EVENT_KEYS, channelsFor, eventFor, validateChannels } from "./events";

describe("notification events", () => {
  it("has unique keys and defaults for every listed event", () => {
    expect(new Set(ALL_EVENT_KEYS).size).toBe(ALL_EVENT_KEYS.length);
    for (const k of ALL_EVENT_KEYS) expect(eventFor(k).defaults.length).toBeGreaterThan(0);
  });
  it("unknown kinds are in-app only, so nothing surprising goes out by email", () => {
    expect(channelsFor("helpdesk.note", null)).toEqual(["in_app"]);
    expect(channelsFor("approval.pending", null)).toEqual(["in_app", "email"]);
  });
  it("a stored setting wins, email-only events never gain in-app, junk is dropped", () => {
    expect(channelsFor("approval.pending", ["email"])).toEqual(["email"]);
    expect(channelsFor("approval.pending", [])).toEqual([]);
    expect(channelsFor("approvals.digest", ["in_app", "email"])).toEqual(["email"]);
    expect(channelsFor("approval.pending", ["sms", "email"] as never)).toEqual(["email"]);
  });
  it("validates what the settings page sends", () => {
    expect(validateChannels("approval.pending", ["in_app", "in_app", "email"])).toEqual(["in_app", "email"]);
    expect(validateChannels("approval.pending", ["pigeon"])).toBeNull();
    expect(validateChannels("made.up", ["email"])).toBeNull();
    expect(validateChannels("approval.pending", "email")).toBeNull();
  });
});
