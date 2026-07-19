import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DEFAULT_GLOBAL_HOTKEY,
  DEFAULT_INTERVAL_MILLISECONDS,
  type ClickerStatus,
  CLICKER_STATUS_EVENT,
} from "./types";
import {
  formatIntervalValue,
  MAX_INTERVAL_MILLISECONDS,
  MIN_INTERVAL_MILLISECONDS,
  parseIntervalValue,
  type IntervalUnit,
} from "./interval";

const HOTKEY_STORAGE_KEY = "ototap.global-hotkey";
const PRESET_INTERVALS = [1000, 5000, 10_000, 30_000];
const DIAL_MIN_ANGLE = -132;
const DIAL_MAX_ANGLE = 132;
const DIAL_CENTER = 120;
const DIAL_TICK_COUNT = 49;
const DIAL_TICK_ANGLES = Array.from({ length: DIAL_TICK_COUNT }, (_, index) => (
  DIAL_MIN_ANGLE + (index / (DIAL_TICK_COUNT - 1)) * (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE)
));
const DIAL_LABELS = [
  { milliseconds: 100, label: "0.1" },
  { milliseconds: 1000, label: "1" },
  { milliseconds: 5000, label: "5" },
  { milliseconds: 10_000, label: "10" },
  { milliseconds: 30_000, label: "30" },
];

const INITIAL_STATUS: ClickerStatus = {
  status: "ready",
  intervalMilliseconds: DEFAULT_INTERVAL_MILLISECONDS,
  hotkey: DEFAULT_GLOBAL_HOTKEY,
  clickCount: 0,
  targetPoint: null,
  nextClickAt: null,
  errorMessage: null,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "The native clicker could not complete that action.";
}

function statusLabel(status: ClickerStatus["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "error":
      return "Attention";
    default:
      return "Ready";
  }
}

function displayHotkeyPart(part: string): string {
  switch (part) {
    case "CTRL":
      return "Ctrl";
    case "ALT":
      return "Alt";
    case "SHIFT":
      return "Shift";
    case "SUPER":
      return "Win";
    default:
      return part;
  }
}

function displayHotkey(hotkey: string): string {
  return hotkey.split("+").map(displayHotkeyPart).join(" + ");
}

function shortcutKey(event: KeyboardEvent<HTMLButtonElement>): string | null {
  if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3);
  }

  if (/^Digit[0-9]$/.test(event.code)) {
    return event.code.slice(5);
  }

  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) {
    return event.code;
  }

  return null;
}

function shortcutFromEvent(event: KeyboardEvent<HTMLButtonElement>): string | null {
  const parts: string[] = [];

  if (event.ctrlKey) {
    parts.push("CTRL");
  }
  if (event.altKey) {
    parts.push("ALT");
  }
  if (event.shiftKey) {
    parts.push("SHIFT");
  }
  if (event.metaKey) {
    parts.push("SUPER");
  }

  const key = shortcutKey(event);

  if (parts.length === 0 || key === null || (parts.length === 1 && parts[0] === "ALT" && key === "F4")) {
    return null;
  }

  parts.push(key);
  return parts.join("+");
}

function intervalErrorMessage(unit: IntervalUnit): string {
  return unit === "seconds"
    ? "Use a value from 0.1 to 30 seconds."
    : "Use a whole number from 100 to 30,000 milliseconds.";
}

function clampInterval(milliseconds: number): number {
  const rounded = Math.round(milliseconds / 100) * 100;
  return Math.min(MAX_INTERVAL_MILLISECONDS, Math.max(MIN_INTERVAL_MILLISECONDS, rounded));
}

function intervalToDialAngle(milliseconds: number): number {
  const value = clampInterval(milliseconds);
  const minimum = Math.log(MIN_INTERVAL_MILLISECONDS);
  const maximum = Math.log(MAX_INTERVAL_MILLISECONDS);
  const ratio = (Math.log(value) - minimum) / (maximum - minimum);
  return DIAL_MIN_ANGLE + ratio * (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE);
}

function dialAngleToInterval(angle: number): number {
  const clampedAngle = Math.min(DIAL_MAX_ANGLE, Math.max(DIAL_MIN_ANGLE, angle));
  const ratio = (clampedAngle - DIAL_MIN_ANGLE) / (DIAL_MAX_ANGLE - DIAL_MIN_ANGLE);
  const minimum = Math.log(MIN_INTERVAL_MILLISECONDS);
  const maximum = Math.log(MAX_INTERVAL_MILLISECONDS);
  return clampInterval(Math.exp(minimum + ratio * (maximum - minimum)));
}

function intervalFromPointer(event: PointerEvent<HTMLButtonElement>): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = event.clientX - bounds.left - bounds.width / 2;
  const y = event.clientY - bounds.top - bounds.height / 2;
  let angle = Math.atan2(y, x) * (180 / Math.PI) + 90;

  if (angle > 180) {
    angle -= 360;
  }

  return dialAngleToInterval(angle);
}

function dialPoint(angle: number, radius: number): { x: number; y: number } {
  const radians = (angle - 90) * (Math.PI / 180);
  return {
    x: DIAL_CENTER + Math.cos(radians) * radius,
    y: DIAL_CENTER + Math.sin(radians) * radius,
  };
}

function App() {
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("seconds");
  const [intervalInput, setIntervalInput] = useState(
    formatIntervalValue(DEFAULT_INTERVAL_MILLISECONDS, "seconds"),
  );
  const [status, setStatus] = useState<ClickerStatus>(INITIAL_STATUS);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [shortcutBusy, setShortcutBusy] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [shortcutMessage, setShortcutMessage] = useState<string | null>(null);
  const dialValueRef = useRef(DEFAULT_INTERVAL_MILLISECONDS);

  const isRunning = status.status === "running";
  const intervalMilliseconds = status.intervalMilliseconds || DEFAULT_INTERVAL_MILLISECONDS;
  const displayedMilliseconds = parseIntervalValue(intervalInput, intervalUnit) ?? intervalMilliseconds;
  const remainingMilliseconds = status.nextClickAt
    ? Math.max(0, status.nextClickAt - now)
    : 0;
  const hotkeyParts = status.hotkey.split("+").map(displayHotkeyPart);
  const dialAngle = intervalToDialAngle(displayedMilliseconds);
  const lcdInputWidth = `${Math.max(3, intervalInput.length + 0.4)}ch`;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;

    const connect = async () => {
      try {
        unlisten = await listen<ClickerStatus>(CLICKER_STATUS_EVENT, (event) => {
          if (active) {
            setStatus(event.payload);
            dialValueRef.current = event.payload.intervalMilliseconds;
            setRuntimeError(null);
          }
        });

        let currentStatus = await invoke<ClickerStatus>("get_clicker_status");
        const savedHotkey = window.localStorage.getItem(HOTKEY_STORAGE_KEY);

        if (savedHotkey && savedHotkey !== currentStatus.hotkey) {
          try {
            currentStatus = await invoke<ClickerStatus>("set_hotkey", { hotkey: savedHotkey });
          } catch {
            window.localStorage.removeItem(HOTKEY_STORAGE_KEY);
          }
        }

        if (active) {
          setStatus(currentStatus);
          dialValueRef.current = currentStatus.intervalMilliseconds;
          setIntervalInput(formatIntervalValue(currentStatus.intervalMilliseconds, "seconds"));
        }
      } catch (error) {
        if (active) {
          setRuntimeError(errorMessage(error));
        }
      }
    };

    void connect();

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isRunning) {
      return undefined;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [isRunning, status.nextClickAt]);

  const syncInterval = useCallback(async (value: string, unit: IntervalUnit) => {
    const milliseconds = parseIntervalValue(value, unit);

    if (milliseconds === null) {
      return;
    }

    try {
      const nextStatus = await invoke<ClickerStatus>("set_interval", {
        intervalMilliseconds: milliseconds,
      });
      setStatus(nextStatus);
      dialValueRef.current = nextStatus.intervalMilliseconds;
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(errorMessage(error));
    }
  }, []);

  const setIntervalFromMilliseconds = useCallback((milliseconds: number, shouldSync: boolean) => {
    const nextMilliseconds = clampInterval(milliseconds);
    const nextValue = formatIntervalValue(nextMilliseconds, "seconds");
    dialValueRef.current = nextMilliseconds;
    setIntervalUnit("seconds");
    setIntervalInput(nextValue);
    setIntervalError(null);

    if (shouldSync) {
      void syncInterval(nextValue, "seconds");
    }
  }, [syncInterval]);

  const runCommand = useCallback(async (command: "start" | "stop") => {
    setBusy(true);
    setRuntimeError(null);

    try {
      if (command === "start") {
        const milliseconds = parseIntervalValue(intervalInput, intervalUnit);

        if (milliseconds === null) {
          setIntervalError(intervalErrorMessage(intervalUnit));
          return;
        }

        setIntervalError(null);
        const nextStatus = await invoke<ClickerStatus>("start_clicker", {
          intervalMilliseconds: milliseconds,
        });
        setStatus(nextStatus);
        return;
      }

      const nextStatus = await invoke<ClickerStatus>("stop_clicker");
      setStatus(nextStatus);
    } catch (error) {
      setRuntimeError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [intervalInput, intervalUnit]);

  const minimizeWindow = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      setRuntimeError(errorMessage(error));
    }
  };

  const toggleMaximizeWindow = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (error) {
      setRuntimeError(errorMessage(error));
    }
  };

  const hideWindow = async () => {
    try {
      await getCurrentWindow().hide();
    } catch (error) {
      setRuntimeError(errorMessage(error));
    }
  };

  const handleTitlebarMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (event.buttons !== 1) {
      return;
    }

    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }

    event.preventDefault();
    void getCurrentWindow().startDragging().catch((error) => {
      setRuntimeError(errorMessage(error));
    });
  };

  const handleResizeMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (event.buttons !== 1) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startResizeDragging("SouthEast").catch((error) => {
      setRuntimeError(errorMessage(error));
    });
  };

  const handleIntervalChange = (value: string) => {
    setIntervalInput(value);
    setIntervalError(null);
    const milliseconds = parseIntervalValue(value, intervalUnit);

    if (milliseconds !== null) {
      dialValueRef.current = milliseconds;
    }

    void syncInterval(value, intervalUnit);
  };

  const handleUnitToggle = () => {
    const milliseconds = parseIntervalValue(intervalInput, intervalUnit) ?? status.intervalMilliseconds;
    const nextUnit: IntervalUnit = intervalUnit === "seconds" ? "milliseconds" : "seconds";
    setIntervalUnit(nextUnit);
    setIntervalInput(formatIntervalValue(milliseconds, nextUnit));
    setIntervalError(null);
  };

  const handleDialPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setIntervalFromMilliseconds(intervalFromPointer(event), false);
  };

  const handleDialPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    setIntervalFromMilliseconds(intervalFromPointer(event), false);
  };

  const handleDialPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const milliseconds = intervalFromPointer(event);
    setIntervalFromMilliseconds(milliseconds, true);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleDialKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 1000 : 100;
    let nextMilliseconds: number | null = null;

    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      nextMilliseconds = dialValueRef.current + step;
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      nextMilliseconds = dialValueRef.current - step;
    } else if (event.key === "Home") {
      nextMilliseconds = MIN_INTERVAL_MILLISECONDS;
    } else if (event.key === "End") {
      nextMilliseconds = MAX_INTERVAL_MILLISECONDS;
    }

    if (nextMilliseconds === null) {
      return;
    }

    event.preventDefault();
    setIntervalFromMilliseconds(nextMilliseconds, true);
  };

  const saveHotkey = async (hotkey: string) => {
    setShortcutBusy(true);
    setShortcutMessage(null);
    setRuntimeError(null);

    try {
      const nextStatus = await invoke<ClickerStatus>("set_hotkey", { hotkey });
      setStatus(nextStatus);
      window.localStorage.setItem(HOTKEY_STORAGE_KEY, nextStatus.hotkey);
    } catch (error) {
      setRuntimeError(errorMessage(error));
    } finally {
      setShortcutBusy(false);
      setIsRecordingShortcut(false);
    }
  };

  const handleShortcutKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!isRecordingShortcut) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setIsRecordingShortcut(false);
      setShortcutMessage(null);
      return;
    }

    const hotkey = shortcutFromEvent(event);

    if (hotkey === null) {
      setShortcutMessage("Hold Ctrl, Alt, Shift, or Win, then press A-Z, 0-9, or F1-F12.");
      return;
    }

    void saveHotkey(hotkey);
  };

  const clickCountLabel = status.clickCount === 1 ? "1 click" : `${status.clickCount.toLocaleString()} clicks`;
  const actionDetail = isRunning
    ? `${clickCountLabel} · next in ${(remainingMilliseconds / 1000).toFixed(1)} s`
    : `Point to the target, then start · ${displayHotkey(status.hotkey)} toggles`;

  const shortcutError = [runtimeError, status.errorMessage].find(
    (message) => message?.toLocaleLowerCase().includes("shortcut"),
  ) ?? null;
  const shortcutFeedback = shortcutMessage ?? shortcutError;
  const generalError = runtimeError && runtimeError !== shortcutError
    ? runtimeError
    : status.errorMessage && status.errorMessage !== shortcutError
      ? status.errorMessage
      : null;

  return (
    <main className={`app-shell ${isRunning ? "is-running" : ""}`}>
      <header className="titlebar" onMouseDown={handleTitlebarMouseDown}>
        <h1>OtoTap</h1>
        <div className={`status-indicator status-indicator--${status.status}`} aria-live="polite">
          <span aria-hidden="true" />
          <strong>{statusLabel(status.status)}</strong>
        </div>
        <div className="window-controls">
          <button
            className="window-button"
            type="button"
            onClick={() => void minimizeWindow()}
            title="Minimize OtoTap"
            aria-label="Minimize OtoTap"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h10" /></svg>
          </button>
          <button
            className="window-button"
            type="button"
            onClick={() => void toggleMaximizeWindow()}
            title="Maximize or restore OtoTap"
            aria-label="Maximize or restore OtoTap"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" /></svg>
          </button>
          <button
            className="window-button window-button--close"
            type="button"
            onClick={() => void hideWindow()}
            title="Hide OtoTap to the tray"
            aria-label="Hide OtoTap to the tray"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
          </button>
        </div>
      </header>

      <section className="interval-stack" aria-labelledby="interval-label">
        <div className="instrument-panel readout-panel">
          <h2 id="interval-label" className="instrument-label">Click interval</h2>

          <div className="lcd-display">
            <div className="lcd-value-well">
              <input
                id="interval"
                className="lcd-value"
                type="number"
                min={intervalUnit === "seconds" ? 0.1 : MIN_INTERVAL_MILLISECONDS}
                max={intervalUnit === "seconds" ? 30 : MAX_INTERVAL_MILLISECONDS}
                step={intervalUnit === "seconds" ? 0.1 : 100}
                inputMode={intervalUnit === "seconds" ? "decimal" : "numeric"}
                value={intervalInput}
                onChange={(event) => handleIntervalChange(event.currentTarget.value)}
                aria-label="Click interval value"
                aria-describedby={intervalError ? "interval-error" : undefined}
                disabled={isRunning || busy}
                autoComplete="off"
                spellCheck={false}
                style={{ width: lcdInputWidth }}
              />
            </div>

            <button
              id="interval-unit"
              className="unit-switch"
              type="button"
              role="switch"
              aria-checked={intervalUnit === "milliseconds"}
              aria-label={`Interval unit: ${intervalUnit}. Switch to ${intervalUnit === "seconds" ? "milliseconds" : "seconds"}.`}
              title={`Switch to ${intervalUnit === "seconds" ? "milliseconds" : "seconds"}`}
              onClick={handleUnitToggle}
              disabled={isRunning || busy}
            >
              <span className="unit-switch__labels" aria-hidden="true">
                <span className="unit-switch__label unit-switch__label--seconds">SEC</span>
                <span className="unit-switch__label unit-switch__label--milliseconds">MS</span>
              </span>
              <span className="unit-switch__track" aria-hidden="true">
                <span className="unit-switch__thumb" />
              </span>
            </button>
          </div>
        </div>

        <div className="instrument-panel dial-panel">
          <div className="dial-stage">
          <button
            className="dial-control"
            type="button"
            role="slider"
            aria-label="Click interval dial"
            aria-valuemin={MIN_INTERVAL_MILLISECONDS}
            aria-valuemax={MAX_INTERVAL_MILLISECONDS}
            aria-valuenow={displayedMilliseconds}
            aria-valuetext={`${formatIntervalValue(displayedMilliseconds, "seconds")} seconds`}
            onPointerDown={handleDialPointerDown}
            onPointerMove={handleDialPointerMove}
            onPointerUp={handleDialPointerUp}
            onPointerCancel={handleDialPointerUp}
            onKeyDown={handleDialKeyDown}
            disabled={isRunning || busy}
            title="Drag to set the interval. Arrow keys adjust by 0.1 seconds; hold Shift for 1 second."
          >
            <span className="dial-scale" aria-hidden="true">
              <svg viewBox="0 0 240 240" focusable="false">
                <g className="dial-minor-ticks">
                  {DIAL_TICK_ANGLES.map((angle, index) => {
                    const outerPoint = dialPoint(angle, 105);
                    const innerPoint = dialPoint(angle, index % 4 === 0 ? 91 : 96);

                    return (
                      <line
                        key={angle}
                        className={index % 4 === 0 ? "is-medium" : undefined}
                        x1={innerPoint.x}
                        y1={innerPoint.y}
                        x2={outerPoint.x}
                        y2={outerPoint.y}
                      />
                    );
                  })}
                </g>
                <g className="dial-major-ticks">
                  {DIAL_LABELS.map((item) => {
                    const angle = intervalToDialAngle(item.milliseconds);
                    const innerPoint = dialPoint(angle, 86);
                    const outerPoint = dialPoint(angle, 106);

                    return (
                      <line
                        key={item.milliseconds}
                        x1={innerPoint.x}
                        y1={innerPoint.y}
                        x2={outerPoint.x}
                        y2={outerPoint.y}
                      />
                    );
                  })}
                </g>
                <g className="dial-labels">
                  {DIAL_LABELS.map((item) => {
                    const labelPoint = dialPoint(intervalToDialAngle(item.milliseconds), 113);

                    return (
                      <text key={item.milliseconds} x={labelPoint.x} y={labelPoint.y}>
                        {item.label}
                      </text>
                    );
                  })}
                </g>
              </svg>
            </span>
            <span className="dial-knob" aria-hidden="true">
              <span className="dial-pointer" style={{ transform: `rotate(${dialAngle}deg)` }}>
                <span />
              </span>
            </span>
          </button>
        </div>

        <div className="preset-row" aria-label="Interval presets">
          {PRESET_INTERVALS.map((milliseconds) => (
            <button
              key={milliseconds}
              type="button"
              className="preset-button"
              onClick={() => setIntervalFromMilliseconds(milliseconds, true)}
              aria-pressed={displayedMilliseconds === milliseconds}
              disabled={isRunning || busy}
            >
              {milliseconds / 1000}s
            </button>
          ))}
          </div>
        </div>
        {intervalError ? <p id="interval-error" className="field-error" role="alert">{intervalError}</p> : null}
      </section>

      <section className="instrument-panel shortcut-panel" aria-labelledby="shortcut-label">
        <h2 id="shortcut-label" className="instrument-label">Toggle shortcut</h2>
        <button
          type="button"
          className={`shortcut-recorder ${isRecordingShortcut ? "is-recording" : ""}`}
          onClick={() => {
            setIsRecordingShortcut(true);
            setShortcutMessage(null);
          }}
          onKeyDown={handleShortcutKeyDown}
          onBlur={() => setIsRecordingShortcut(false)}
          aria-pressed={isRecordingShortcut}
          aria-label={
            isRecordingShortcut
              ? "Recording a new toggle shortcut. Press a modifier and a letter, number, or function key."
              : `Change toggle shortcut. Current shortcut is ${displayHotkey(status.hotkey)}.`
          }
          disabled={shortcutBusy}
          aria-describedby={shortcutFeedback ? "shortcut-feedback" : undefined}
        >
          <span className="keycap-row" aria-hidden="true">
            {isRecordingShortcut ? (
              <span className="listening-copy">Press shortcut...</span>
            ) : hotkeyParts.map((part) => <kbd key={part}>{part}</kbd>)}
          </span>
          <span className="record-button" aria-hidden="true">
            {shortcutBusy ? "Save" : isRecordingShortcut ? "Listen" : "Rec"}
          </span>
        </button>
        {shortcutFeedback ? (
          <p
            id="shortcut-feedback"
            className={"shortcut-message" + (shortcutError ? " is-error" : "")}
            role={shortcutError ? "alert" : "status"}
          >
            {shortcutFeedback}
          </p>
        ) : null}
      </section>

      <button
        className={`run-button ${isRunning ? "stop" : "start"}`}
        type="button"
        onClick={() => void runCommand(isRunning ? "stop" : "start")}
        disabled={busy}
        title={`${isRunning ? "Stop" : "Start"} clicking (${displayHotkey(status.hotkey)})`}
      >
        <span className="run-button-indicator" aria-hidden="true">
          {isRunning ? <span className="stop-glyph" /> : <span className="start-glyph" />}
        </span>
        <span className="run-button-copy">
          <strong>{busy ? "Working..." : isRunning ? "Stop clicking" : "Start clicking"}</strong>
          <small>{actionDetail}</small>
        </span>
      </button>

      {generalError ? (
        <div className="error-banner" role="alert">
          <span aria-hidden="true">!</span>
          <span>{generalError}</span>
        </div>
      ) : null}

      <div
        className="resize-handle"
        onMouseDown={handleResizeMouseDown}
        aria-hidden="true"
      />
    </main>
  );
}

export default App;
