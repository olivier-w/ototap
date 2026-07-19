export const MIN_INTERVAL_MILLISECONDS = 100;
export const MAX_INTERVAL_MILLISECONDS = 30_000;

export type IntervalUnit = "milliseconds" | "seconds";

export function parseIntervalMilliseconds(rawValue: string): number | null {
  const value = rawValue.trim();

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const milliseconds = Number(value);

  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < MIN_INTERVAL_MILLISECONDS
    || milliseconds > MAX_INTERVAL_MILLISECONDS
  ) {
    return null;
  }

  return milliseconds;
}

export function parseIntervalValue(rawValue: string, unit: IntervalUnit): number | null {
  if (unit === "milliseconds") {
    return parseIntervalMilliseconds(rawValue);
  }

  const value = rawValue.trim();

  if (!/^\d+(?:\.\d{0,3})?$/.test(value)) {
    return null;
  }

  const milliseconds = Number(value) * 1000;

  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < MIN_INTERVAL_MILLISECONDS
    || milliseconds > MAX_INTERVAL_MILLISECONDS
  ) {
    return null;
  }

  return milliseconds;
}

export function formatIntervalValue(milliseconds: number, unit: IntervalUnit): string {
  if (unit === "milliseconds") {
    return String(milliseconds);
  }

  const seconds = milliseconds / 1000;
  return Number.isInteger(seconds) ? seconds.toFixed(1) : String(seconds);
}
