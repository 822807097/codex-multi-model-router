import { useUpdate } from "../hooks/useUpdate";

/**
 * Shows a banner when an update is available or being installed. Hidden when
 * idle / up to date so it stays out of the way.
 */
export default function UpdateBanner() {
  const { phase, version, error, downloadAndInstall, dismiss } = useUpdate();

  if (phase === "idle" || phase === "checking" || phase === "uptodate") {
    return null;
  }

  return (
    <div className="update-banner">
      {phase === "available" && (
        <>
          <span className="update-banner__text">
            Update available{version ? ` (v${version})` : ""}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => void downloadAndInstall()}
            >
              Install
            </button>
            <button type="button" className="btn btn--sm" onClick={dismiss}>
              Later
            </button>
          </span>
        </>
      )}

      {phase === "downloading" && (
        <span className="update-banner__text">Downloading update…</span>
      )}

      {phase === "ready" && (
        <span className="update-banner__text">Restarting to apply update…</span>
      )}

      {phase === "error" && (
        <>
          <span className="update-banner__text" style={{ color: "var(--danger)" }}>
            Update failed{error ? `: ${error}` : ""}
          </span>
          <button type="button" className="btn btn--sm" onClick={dismiss}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
