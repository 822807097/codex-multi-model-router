import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ServerStatus {
  running: boolean;
  port: number;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Tracks the sidecar server lifecycle. Polls `get_server_status` on an interval
 * and exposes start/stop actions plus the live base URL.
 */
export function useServer() {
  const [status, setStatus] = useState<ServerStatus>({
    running: false,
    port: 8787,
  });
  const [baseUrl, setBaseUrl] = useState<string>("http://127.0.0.1:8787/v1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refreshBaseUrl = useCallback(async () => {
    try {
      const url = await invoke<string>("get_base_url");
      if (mounted.current) setBaseUrl(url);
    } catch (e) {
      // base URL is derived from settings; ignore transient failures.
      console.error("get_base_url failed", e);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await invoke<ServerStatus>("get_server_status");
      if (mounted.current) setStatus(next);
    } catch (e) {
      console.error("get_server_status failed", e);
    }
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ServerStatus>("start_server");
      if (mounted.current) setStatus(next);
      await refreshBaseUrl();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [refreshBaseUrl]);

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<ServerStatus>("stop_server");
      if (mounted.current) setStatus(next);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const toggle = useCallback(async () => {
    if (status.running) {
      await stop();
    } else {
      await start();
    }
  }, [status.running, start, stop]);

  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    void refreshBaseUrl();
    const id = window.setInterval(refreshStatus, POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [refreshStatus, refreshBaseUrl]);

  return { status, baseUrl, busy, error, start, stop, toggle, refreshStatus };
}
