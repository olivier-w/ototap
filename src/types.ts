export type SessionStatus = "ready" | "running" | "stopped" | "error";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ClickerStatus {
  status: SessionStatus;
  intervalMilliseconds: number;
  clickCount: number;
  targetPoint: ScreenPoint | null;
  nextClickAt: number | null;
  errorMessage: string | null;
}

export const CLICKER_STATUS_EVENT = "clicker-status";
export const GLOBAL_HOTKEY = "Ctrl+Alt+A";
export const DEFAULT_INTERVAL_MILLISECONDS = 5000;
