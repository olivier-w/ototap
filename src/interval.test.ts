import { describe, expect, test } from "bun:test";
import {
  MAX_INTERVAL_MILLISECONDS,
  MIN_INTERVAL_MILLISECONDS,
  parseIntervalMilliseconds,
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