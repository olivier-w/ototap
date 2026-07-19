export type SessionStatus = "ready" | "running" | "stopped" | "error";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ClickerStatus {
  status: SessionStatus;
  intervalMilliseconds: number;
  hotkey: string;
  clickCount: number;
  targetPoint: ScreenPoint | null;
  nextClickAt: number | null;
  errorMessage: string | null;
}

export const CLICKER_STATUS_EVENT = "clicker-status";
export const DEFAULT_GLOBAL_HOTKEY = "CTRL+ALT+A";
export const DEFAULT_INTERVAL_MILLISECONDS = 5000;
