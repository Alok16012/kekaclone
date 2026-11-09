import { describe, expect, it } from "vitest";
import { format, formatDate, formatNumber, t } from "./index";
import { coverage, MESSAGES } from "./messages";
import { DAY_STATUS, REQUEST_KIND } from "@/features/attendance/status";

describe("i18n", () => {
  it("substitutes variables and plural forms per locale", () => {
    expect(t("en", "home.approvals", { count: 1 })).toBe("1 request needs your approval");
    expect(t("en", "home.approvals", { count: 3 })).toBe("3 requests need your approval");
    expect(t("hi", "home.approvals", { count: 1 })).toBe("1 अनुरोध आपकी मंज़ूरी का इंतज़ार कर रहा है");
    expect(t("hi", "shell.account_menu", { name: "Asha" })).toBe("Asha का खाता मेनू");
    expect(format("en", "{a} and {b}", { a: "x" })).toBe("x and ");
  });
  it("falls back to English, then the key", () => {
    expect(t("hi", "common.save")).toBe("सहेजें");
    expect(t("hi", "nav.home")).toBe("होम");
    expect(t("hi", "zzz.missing" as never)).toBe("zzz.missing");
  });
  it("formats dates and numbers in the locale", () => {
    expect(formatDate("en", "2026-11-03")).toBe("Tuesday, 3 November");
    expect(formatDate("hi", "2026-11-03")).toContain("नवंबर");
    expect(formatNumber("en", 12345.5)).toBe("12,345.5");
    expect(formatNumber("hi", 2)).toBe("2");
  });
  it("hindi covers every key the shell, Home, Leave, Attendance, Inbox, Profile and login use", () => {
    const missing = Object.keys(MESSAGES.en).filter((k) => !(k in MESSAGES.hi));
    expect(missing).toEqual([]);
    expect(coverage("hi").percent).toBe(100);
  });
  it("every attendance day status and request kind has a catalogue entry", () => {
    for (const k of Object.keys(DAY_STATUS)) expect(MESSAGES.en).toHaveProperty([`att.status.${k}`]);
    for (const k of Object.keys(REQUEST_KIND)) expect(MESSAGES.en).toHaveProperty([`att.kind.${k}`]);
    expect(t("hi", "leave.days", { count: 2 })).toBe("2 दिन");
    expect(t("en", "leave.days", { count: 1 })).toBe("1 day");
    expect(t("en", "att.withdraw_desc", { title: "Regularize", detail: "3 Nov" })).toBe("Regularize, 3 Nov. Your manager won't need to review it anymore.");
  });
});
