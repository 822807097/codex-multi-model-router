import { useCallback, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

/**
 * Wraps the Tauri updater plugin: check for a new release, download + install
 * it, then relaunch. Keeps a small state machine so the UI can show a banner.
 */
export function useUpdate() {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Update | null>(null);

  const checkForUpdate = useCallback(async () => {
    setPhase("checking");
    setError(null);
    try {
      const update = await check();
      if (update) {
        pending.current = update;
        setVersion(update.version);
        setPhase("available");
      } else {
        pending.current = null;
        setPhase("uptodate");
      }
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    setPhase("downloading");
    setError(null);
    try {
      await update.downloadAndInstall();
      setPhase("ready");
      await relaunch();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }, []);

  const dismiss = useCallback(() => {
    pending.current = null;
    setPhase("idle");
  }, []);

  return {
    phase,
    version,
    error,
    checkForUpdate,
    downloadAndInstall,
    dismiss,
  };
}
