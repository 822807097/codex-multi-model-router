import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Manages the stored Cursor API key via the Windows Credential Manager
 * (exposed through Tauri commands). Never holds the key in component state
 * longer than needed; `hasKey` reflects presence without exposing the value.
 */
export function useCredentials() {
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const present = await invoke<boolean>("has_api_key");
      if (mounted.current) setHasKey(present);
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const getKey = useCallback(async (): Promise<string> => {
    return invoke<string>("get_api_key");
  }, []);

  const setKey = useCallback(
    async (key: string) => {
      setError(null);
      await invoke("set_api_key", { key });
      await refresh();
    },
    [refresh],
  );

  const deleteKey = useCallback(async () => {
    setError(null);
    await invoke("delete_api_key");
    await refresh();
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { hasKey, loading, error, getKey, setKey, deleteKey, refresh };
}
