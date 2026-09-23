import { useEffect } from "preact/hooks";
import { getState, setSettingsOpen, useSelector } from "../store";
import { post } from "../vscode";
import { AgentPathControl } from "./SettingsView";
import { Icon } from "./ui";

const SETUP_PATTERN = /not found|no such file|enoent|not logged in|log ?in|sign ?in|authenticat|unauthori[sz]ed|cannot find|is not recognized/i;

/** True when the connection failed for a reason the user can fix by configuring the agent. */
export function useNeedsSetup(): boolean {
  const connection = useSelector((s) => s.session.connection);
  const lastError = useSelector((s) => s.session.lastError);
  const probe = useSelector((s) => s.probe);
  const ids = useSelector((s) => s.ids);
  if (connection !== "error") return false;
  if (probe && (probe.state === "notFound" || probe.state === "failed")) return true;
  if (probe && probe.state === "ok") return SETUP_PATTERN.test(lastError ?? "");
  if (lastError && SETUP_PATTERN.test(lastError)) return true;
  // Most recent error notice, if any.
  const items = getState().items;
  for (let i = ids.length - 1; i >= 0; i--) {
    const it = items.get(ids[i] ?? "");
    if (it && it.type === "notice" && it.level === "error") return SETUP_PATTERN.test(`${it.text}\n${it.detail ?? ""}`);
  }
  return false;
}

export function SetupCard() {
  const settings = useSelector((s) => s.extSettings);
  const probe = useSelector((s) => s.probe);
  useEffect(() => {
    if (!settings) post({ type: "settings.get" });
    if (!probe) post({ type: "settings.probe" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="card setup-card" role="region" aria-labelledby="setup-title">
      <div class="card-title">
        <Icon name="rocket" />
        <span id="setup-title">Set up Cursor Agent</span>
      </div>
      <p class="setup-text">
        The Cursor Agent CLI could not be started. Install it, or point the extension at the <code>agent</code> executable (or a wrapper script), and make sure you are logged in.
      </p>
      <label class="setting-label" for="setup-agentPath">
        Agent path
      </label>
      <AgentPathControl id="setup-agentPath" value={settings?.agentPath ?? ""} />
      <div class="card-actions">
        <button type="button" class="button primary" onClick={() => post({ type: "session.reconnect" })}>
          <Icon name="plug" /> Connect
        </button>
        <button type="button" class="button secondary" onClick={() => setSettingsOpen(true)}>
          All settings
        </button>
      </div>
    </div>
  );
}
