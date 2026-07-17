import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DEFAULT_INTERVAL_MILLISECONDS,
  GLOBAL_HOTKEY,
  type ClickerStatus,
  CLICKER_STATUS_EVENT,
} from "./types";
import { MAX_INTERVAL_MILLISECONDS, MIN_INTERVAL_MILLISECONDS, parseIntervalMilliseconds } from "./interval";

const INITIAL_STATUS: ClickerStatus = {
  status: "ready",
  intervalMilliseconds: DEFAULT_INTERVAL_MILLISECONDS,
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
      return "Needs attention";
    default:
      return "Ready";
  }
}

function formatTarget(targetPoint: ClickerStatus["targetPoint"]): string {
  return targetPoint ? `${targetPoint.x}, ${targetPoint.y}` : "Not captured";
}

function App() {
  const [intervalInput, setIntervalInput] = useState(String(DEFAULT_INTERVAL_MILLISECONDS));
  const [status, setStatus] = useState<ClickerStatus>(INITIAL_STATUS);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [intervalError, setIntervalError] = useState<string | null>(null);

  const isRunning = status.status === "running";
  const intervalMilliseconds = status.intervalMilliseconds || DEFAULT_INTERVAL_MILLISECONDS;
  const remainingMilliseconds = status.nextClickAt
    ? Math.max(0, status.nextClickAt - now)
    : 0;
  const progress = isRunning
    ? Math.min(100, Math.max(0, ((intervalMilliseconds - remainingMilliseconds) / intervalMilliseconds) * 100))
    : 0;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;

    const connect = async () => {
      try {
        unlisten = await listen<ClickerStatus>(CLICKER_STATUS_EVENT, (event) => {
          if (active) {
            setStatus(event.payload);
            setRuntimeError(null);
          }
        });

        const currentStatus = await invoke<ClickerStatus>("get_clicker_status");

        if (active) {
          setStatus(currentStatus);
          setIntervalInput(String(currentStatus.intervalMilliseconds));
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

  const buttonLabel = useMemo(() => (isRunning ? "Stop clicking" : "Start clicking"), [isRunning]);

  const runCommand = useCallback(async (command: "start" | "stop" | "toggle") => {
    setBusy(true);
    setRuntimeError(null);

    try {
      if (command === "start") {
        const milliseconds = parseIntervalMilliseconds(intervalInput);

        if (milliseconds === null) {
          setIntervalError(`Choose a whole number from ${MIN_INTERVAL_MILLISECONDS} to ${MAX_INTERVAL_MILLISECONDS} ms.`);
          return;
        }

        setIntervalError(null);
        const nextStatus = await invoke<ClickerStatus>("start_clicker", {
          intervalMilliseconds: milliseconds,
        });
        setStatus(nextStatus);
        return;
      }

      const nextStatus = await invoke<ClickerStatus>(command === "stop" ? "stop_clicker" : "toggle_clicker");
      setStatus(nextStatus);
    } catch (error) {
      setRuntimeError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }, [intervalInput]);

  const hideWindow = async () => {
    try {
      await getCurrentWindow().hide();
    } catch (error) {
      setRuntimeError(errorMessage(error));
    }
  };

  const handleIntervalChange = (value: string) => {
    setIntervalInput(value);
    if (intervalError) {
      setIntervalError(null);
    }
  };

  return (
    <main className={`app-shell ${isRunning ? "is-running" : ""}`}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">+</span>
          <div>
            <p className="eyebrow">OtoTap / Windows utility</p>
            <h1>Auto clicker</h1>
          </div>
        </div>
        <button className="icon-button" type="button" onClick={hideWindow} title="Hide OtoTap to the tray" aria-label="Hide OtoTap to the tray">
          <span aria-hidden="true">—</span>
        </button>
      </header>

      <section className="status-strip" aria-live="polite">
        <span className={`status-dot ${isRunning ? "active" : ""}`} aria-hidden="true" />
        <span className="status-name">{statusLabel(status.status)}</span>
        <span className="status-divider" aria-hidden="true">/</span>
        <span className="status-detail">{isRunning ? `next tap in ${(remainingMilliseconds / 1000).toFixed(1)}s` : "armed when you are"}</span>
        <span className="hotkey-chip">{GLOBAL_HOTKEY}</span>
      </section>

      <section className="hero-panel" aria-labelledby="interval-heading">
        <div className="panel-kicker"><span>01</span><span>Timing window</span></div>
        <div className="interval-display">
          <label htmlFor="interval">Tap every</label>
          <div className="interval-input-wrap">
            <input
              id="interval"
              type="number"
              min={MIN_INTERVAL_MILLISECONDS}
              max={MAX_INTERVAL_MILLISECONDS}
              step="100"
              value={intervalInput}
              onChange={(event) => handleIntervalChange(event.currentTarget.value)}
              aria-describedby="interval-help interval-error"
              disabled={isRunning || busy}
            />
            <span aria-hidden="true">ms</span>
          </div>
          <h2 id="interval-heading" className="sr-only">Click interval</h2>
        </div>
        <p id="interval-help" className="helper-text">Fixed interval · 100 ms steps · 100 ms—30 sec</p>
        {intervalError ? <p id="interval-error" className="field-error" role="alert">{intervalError}</p> : null}
        <div className="progress-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      </section>

      <section className="detail-grid" aria-label="Session details">
        <div className="detail-card">
          <span className="detail-label">Captured target</span>
          <strong>{formatTarget(status.targetPoint)}</strong>
          <small>screen coordinates</small>
        </div>
        <div className="detail-card">
          <span className="detail-label">Clicks sent</span>
          <strong>{status.clickCount.toLocaleString()}</strong>
          <small>left button</small>
        </div>
      </section>

      <button className={`run-button ${isRunning ? "stop" : "start"}`} type="button" onClick={() => void runCommand(isRunning ? "stop" : "start")} disabled={busy}>
        <span className="run-button-icon" aria-hidden="true">{isRunning ? "■" : "↗"}</span>
        <span>{busy ? "Working…" : buttonLabel}</span>
        <span className="run-button-hint">{isRunning ? "safe stop" : "captures cursor"}</span>
      </button>

      <div className="footer-note">
        <span className="footer-signal" aria-hidden="true">●</span>
        <span>Start captures the cursor position. Close hides to tray; Quit from the tray to exit.</span>
      </div>

      {runtimeError || status.errorMessage ? (
        <div className="error-banner" role="alert">
          <span aria-hidden="true">!</span>
          <span>{runtimeError ?? status.errorMessage}</span>
        </div>
      ) : null}
    </main>
  );
}

export default App;