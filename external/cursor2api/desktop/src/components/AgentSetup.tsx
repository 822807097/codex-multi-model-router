import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type AgentStatus = "configured" | "not_configured" | "not_installed";

interface AgentInfo {
  id: string;
  name: string;
  status: AgentStatus;
}

interface AgentSetupProps {
  baseUrl: string;
}

// The agent-config local API key literal (never the real key). See contract §1.
const LOCAL_API_KEY = "cursor-local";

export default function AgentSetup({ baseUrl }: AgentSetupProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const list = await invoke<AgentInfo[]>("get_supported_agents", {
        baseUrl,
      });
      setAgents(list);
    } catch (e) {
      console.error("get_supported_agents failed", e);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const configure = async (agent: AgentInfo) => {
    setPending((p) => ({ ...p, [agent.id]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[agent.id];
      return next;
    });
    try {
      await invoke<string>("configure_agent", {
        agentId: agent.id,
        baseUrl,
        apiKey: LOCAL_API_KEY,
      });
      await load();
    } catch (e) {
      setErrors((prev) => ({ ...prev, [agent.id]: String(e) }));
    } finally {
      setPending((p) => ({ ...p, [agent.id]: false }));
    }
  };

  return (
    <section className="section">
      <h2 className="section__title">Configure Agents</h2>
      <div className="agent-grid">
        {agents.map((agent) => {
          const isPending = pending[agent.id];
          const installed = agent.status !== "not_installed";
          const configured = agent.status === "configured";
          return (
            <div className="agent-card" key={agent.id}>
              <span className="agent-card__name">{agent.name}</span>
              <button
                type="button"
                className={`btn btn--sm ${configured ? "" : "btn--primary"}`}
                onClick={() => void configure(agent)}
                disabled={isPending || !installed}
              >
                {isPending
                  ? "…"
                  : !installed
                    ? "Unavailable"
                    : configured
                      ? "✓ Configured"
                      : "Configure"}
              </button>
              {errors[agent.id] && (
                <span
                  className="agent-card__status"
                  style={{ color: "var(--danger)" }}
                  title={errors[agent.id]}
                >
                  Failed
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
