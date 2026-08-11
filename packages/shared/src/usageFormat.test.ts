import { describe, expect, it } from "vite-plus/test";

import { enumerateDays, formatDayShort, formatTokens } from "./usageFormat.ts";

describe("formatTokens", () => {
  it("promotes values that round across a unit boundary", () => {
    expect(formatTokens(999_999)).toBe("1M");
    expect(formatTokens(-999_999_999)).toBe("-1B");
    expect(formatTokens(999_499)).toBe("999K");
  });
});

describe("calendar-day formatting", () => {
  it("formats valid calendar days", () => {
    expect(formatDayShort("2026-08-07")).toBe("Aug 7");
    expect(enumerateDays("2026-02-27", "2026-03-01")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
  });

  it("rejects malformed and impossible calendar days", () => {
    expect(formatDayShort("2026-02-30")).toBe("2026-02-30");
    expect(formatDayShort("2026-08-07-extra")).toBe("2026-08-07-extra");
    expect(enumerateDays("2026-02-30", "2026-03-01")).toEqual([]);
    expect(enumerateDays("2026-02-27", "2026-02-30")).toEqual([]);
  });
});
