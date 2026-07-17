export const MIN_INTERVAL_MILLISECONDS = 100;
export const MAX_INTERVAL_MILLISECONDS = 30_000;

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