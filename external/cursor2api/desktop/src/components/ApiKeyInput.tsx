import { useState } from "react";
import { useCredentials } from "../hooks/useCredentials";

export default function ApiKeyInput() {
  const { hasKey, loading, setKey, deleteKey } = useCredentials();
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await setKey(trimmed);
      setValue("");
      setReveal(false);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      await deleteKey();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section field">
      <label className="field__label" htmlFor="api-key">
        Cursor API Key
      </label>
      <div className="input-row">
        <input
          id="api-key"
          className="input input--mono"
          type={reveal ? "text" : "password"}
          placeholder="key_…"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button
          type="button"
          className="btn btn--sm"
          aria-label={reveal ? "Hide key" : "Show key"}
          title={reveal ? "Hide key" : "Show key"}
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? "🙈" : "👁"}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => void save()}
          disabled={saving || value.trim().length === 0}
        >
          Save
        </button>
      </div>

      {error ? (
        <span className="hint" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      ) : justSaved ? (
        <span className="hint hint--ok">Key saved</span>
      ) : loading ? (
        <span className="hint">Checking…</span>
      ) : hasKey ? (
        <span className="hint hint--ok">
          Key saved.{" "}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ padding: 0, color: "var(--danger)" }}
            onClick={() => void remove()}
            disabled={saving}
          >
            Remove
          </button>
        </span>
      ) : (
        <span className="hint">No key stored</span>
      )}
    </section>
  );
}
