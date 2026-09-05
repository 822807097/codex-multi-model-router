import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ServerStatus as Status } from "../hooks/useServer";

interface ServerStatusProps {
  status: Status;
  baseUrl: string;
  busy: boolean;
  error: string | null;
  onToggle: () => void | Promise<void>;
}

export default function ServerStatus({
  status,
  baseUrl,
  busy,
  error,
  onToggle,
}: ServerStatusProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await writeText(baseUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("copy failed", e);
    }
  };

  return (
    <section className="section server">
      <div className="server__row">
        <span className="status">
          <span
            className={`status__dot ${
              status.running ? "status__dot--running" : "status__dot--stopped"
            }`}
          />
          {status.running ? "Running" : "Stopped"}
        </span>
        <button
          type="button"
          className={`btn btn--sm ${status.running ? "btn--danger" : "btn--primary"}`}
          onClick={() => void onToggle()}
          disabled={busy}
        >
          {busy ? "…" : status.running ? "Stop" : "Start"}
        </button>
      </div>

      <div className="url-row">
        <span className="url-row__value" title={baseUrl}>
          {baseUrl}
        </span>
        <button type="button" className="btn btn--sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {error && <span className="hint" style={{ color: "var(--danger)" }}>{error}</span>}
    </section>
  );
}
