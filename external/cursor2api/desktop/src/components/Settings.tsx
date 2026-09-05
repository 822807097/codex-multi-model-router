import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useUpdate } from "../hooks/useUpdate";

interface AppSettings {
  port: number;
  autostart: boolean;
}

const DEFAULT_PORT = 8787;
const MAX_LOG_LINES = 200;

export default function Settings() {
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState<number>(DEFAULT_PORT);
  const [portInput, setPortInput] = useState<string>(String(DEFAULT_PORT));
  const [autostart, setAutostart] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [savingPort, setSavingPort] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { phase, version, checkForUpdate } = useUpdate();
  const logRef = useRef<HTMLDivElement>(null);

  // Load persisted settings + autostart state on mount.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const settings = await invoke<AppSettings>("get_settings");
        if (!active) return;
        setPort(settings.port);
        setPortInput(String(settings.port));
        setAutostart(settings.autostart);
      } catch (e) {
        console.error("get_settings failed", e);
      }
      try {
        const enabled = await invoke<boolean>("is_autostart_enabled");
        if (active) setAutostart(enabled);
      } catch (e) {
        console.error("is_autostart_enabled failed", e);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Subscribe to server log events emitted by the backend.
  useEffect(() => {
    const unlisten = listen<string>("server-log", (event) => {
      setLogs((prev) => {
        const next = [...prev, event.payload];
        return next.length > MAX_LOG_LINES
          ? next.slice(next.length - MAX_LOG_LINES)
          : next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-scroll the log viewer to the bottom on new lines.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const savePort = async () => {
    const parsed = Number.parseInt(portInput, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setError("Port must be between 1 and 65535");
      return;
    }
    setSavingPort(true);
    setError(null);
    try {
      await invoke("set_port", { port: parsed });
      setPort(parsed);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingPort(false);
    }
  };

  const toggleAutostart = async () => {
    const next = !autostart;
    setAutostart(next);
    setError(null);
    try {
      await invoke("set_autostart_enabled", { enabled: next });
    } catch (e) {
      setAutostart(!next); // revert on failure
      setError(String(e));
    }
  };

  return (
    <section className="section">
      <button
        type="button"
        className="collapsible__header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>Settings</span>
        <span
          className={`collapsible__chevron ${open ? "collapsible__chevron--open" : ""}`}
        >
          ▶
        </span>
      </button>

      {open && (
        <div className="collapsible__body">
          <div className="field">
            <label className="field__label" htmlFor="port">
              Server port
            </label>
            <div className="input-row">
              <input
                id="port"
                className="input input--narrow"
                type="number"
                min={1}
                max={65535}
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void savePort();
                }}
              />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void savePort()}
                disabled={savingPort || portInput === String(port)}
              >
                Save
              </button>
            </div>
            <span className="hint">Default {DEFAULT_PORT}. Takes effect on next start.</span>
          </div>

          <div className="toggle-row">
            <span className="toggle-row__label">Start with Windows</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={autostart}
                onChange={() => void toggleAutostart()}
              />
              <span className="switch__track" />
            </label>
          </div>

          <div className="field">
            <button
              type="button"
              className="btn btn--sm btn--block"
              onClick={() => void checkForUpdate()}
              disabled={phase === "checking" || phase === "downloading"}
            >
              {phase === "checking" ? "Checking…" : "Check for updates"}
            </button>
            {phase === "uptodate" && (
              <span className="hint hint--ok">You're up to date.</span>
            )}
            {phase === "available" && (
              <span className="hint">Update v{version} available.</span>
            )}
          </div>

          <div className="field">
            <label className="field__label">Server log</label>
            <div className="log-viewer" ref={logRef}>
              {logs.length === 0 ? (
                <span className="log-viewer__empty">No log output yet.</span>
              ) : (
                logs.join("\n")
              )}
            </div>
          </div>

          {error && (
            <span className="hint" style={{ color: "var(--danger)" }}>
              {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
