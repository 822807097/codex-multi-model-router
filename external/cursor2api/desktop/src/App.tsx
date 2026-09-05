import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import ServerStatus from "./components/ServerStatus";
import ApiKeyInput from "./components/ApiKeyInput";
import AgentSetup from "./components/AgentSetup";
import UpdateBanner from "./components/UpdateBanner";
import Settings from "./components/Settings";
import { useServer } from "./hooks/useServer";

const GITHUB_REPO_URL = "https://github.com/standardagents/composer-api";

export default function App() {
  const { status, baseUrl, busy, error, toggle } = useServer();
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    let active = true;
    invoke<string>("get_app_version")
      .then((v) => {
        if (active) setVersion(v);
      })
      .catch((e) => console.error("get_app_version failed", e));
    return () => {
      active = false;
    };
  }, []);

  const openRepo = async () => {
    try {
      await open(GITHUB_REPO_URL);
    } catch (e) {
      console.error("open repo failed", e);
    }
  };

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">API for Cursor</h1>
      </header>

      <main className="app__body">
        <UpdateBanner />
        <ServerStatus
          status={status}
          baseUrl={baseUrl}
          busy={busy}
          error={error}
          onToggle={toggle}
        />
        <ApiKeyInput />
        <AgentSetup baseUrl={baseUrl} />
        <Settings />
      </main>

      <footer className="app__footer">
        <span>v{version || "…"}</span>
        <a
          href={GITHUB_REPO_URL}
          onClick={(e) => {
            e.preventDefault();
            void openRepo();
          }}
        >
          GitHub
        </a>
      </footer>
    </div>
  );
}
