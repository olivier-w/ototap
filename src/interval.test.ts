import { describe, expect, test } from "bun:test";
import {
  formatIntervalValue,
  MAX_INTERVAL_MILLISECONDS,
  MIN_INTERVAL_MILLISECONDS,
  parseIntervalMilliseconds,
  parseIntervalValue,
} from "./interval";

describe("parseIntervalMilliseconds", () => {
  test("accepts the supported bounds", () => {
    expect(parseIntervalMilliseconds(String(MIN_INTERVAL_MILLISECONDS))).toBe(MIN_INTERVAL_MILLISECONDS);
    expect(parseIntervalMilliseconds(String(MAX_INTERVAL_MILLISECONDS))).toBe(MAX_INTERVAL_MILLISECONDS);
  });

  test("accepts whitespace around an integer", () => {
    expect(parseIntervalMilliseconds(" 150 ")).toBe(150);
  });

  test("rejects decimals, text, and values outside the bounds", () => {
    expect(parseIntervalMilliseconds("100.5")).toBeNull();
    expect(parseIntervalMilliseconds("fast")).toBeNull();
    expect(parseIntervalMilliseconds("99")).toBeNull();
    expect(parseIntervalMilliseconds("30001")).toBeNull();
  });
});

describe("parseIntervalValue", () => {
  test("converts seconds to whole milliseconds", () => {
    expect(parseIntervalValue("0.1", "seconds")).toBe(100);
    expect(parseIntervalValue("5.0", "seconds")).toBe(5000);
    expect(parseIntervalValue("30", "seconds")).toBe(30000);
  });

  test("rejects unsupported second values", () => {
    expect(parseIntervalValue("0.01", "seconds")).toBeNull();
    expect(parseIntervalValue("30.1", "seconds")).toBeNull();
    expect(parseIntervalValue("1.0001", "seconds")).toBeNull();
  });

  test("formats values for the selected unit", () => {
    expect(formatIntervalValue(5000, "seconds")).toBe("5.0");
    expect(formatIntervalValue(250, "seconds")).toBe("0.25");
    expect(formatIntervalValue(250, "milliseconds")).toBe("250");
  });
});
