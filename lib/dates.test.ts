import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDateDisplay,
  formatLocalYMD,
  localToday,
  parseLocalDate,
} from "./dates";

afterEach(() => {
  vi.useRealTimers();
});

describe("parseLocalDate", () => {
  it("returns a Date whose local fields match the YMD input", () => {
    const d = parseLocalDate("2026-04-22");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(22);
  });

  it("round-trips through formatLocalYMD", () => {
    expect(formatLocalYMD(parseLocalDate("2026-01-03"))).toBe("2026-01-03");
    expect(formatLocalYMD(parseLocalDate("2026-12-31"))).toBe("2026-12-31");
  });
});

describe("formatLocalYMD", () => {
  it("pads month and day", () => {
    const d = new Date(2026, 0, 3, 12);
    expect(formatLocalYMD(d)).toBe("2026-01-03");
  });
});

describe("localToday", () => {
  it("uses local calendar date, not UTC", () => {
    vi.useFakeTimers();
    // 11:30 PM on April 22 local — a moment when UTC has already rolled
    // forward to April 23 in the eastern US.
    vi.setSystemTime(new Date(2026, 3, 22, 23, 30));
    expect(localToday()).toBe("2026-04-22");
  });

  it("uses local calendar date in early morning too", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 22, 0, 15));
    expect(localToday()).toBe("2026-04-22");
  });
});

describe("formatDateDisplay", () => {
  it("renders the same day that was passed in", () => {
    const s = formatDateDisplay("2026-04-22", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    expect(s).toMatch(/22/);
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/04/);
  });
});
