import { useEffect } from "preact/hooks";
import { getState, setSettingsOpen, useSelector } from "../store";
import { post } from "../vscode";
import { AgentPathControl } from "./SettingsView";
import { Icon, Spinner } from "./ui";

const SETUP_PATTERN = /not found|no such file|enoent|not logged in|log ?in|sign ?in|authenticat|unauthori[sz]ed|cannot find|is not recognized/i;

/** True when the connection failed for a reason the user can fix by configuring the agent. */
export function useNeedsSetup(): boolean {
  const connection = useSelector((s) => s.session.connection);
  const lastError = useSelector((s) => s.session.lastError);
  const authRequired = useSelector((s) => s.session.authRequired);
  const probe = useSelector((s) => s.probe);
  const ids = useSelector((s) => s.ids);
  if (connection !== "error") return false;
  if (authRequired) return true;
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

function StatusLine() {
  const status = useSelector((s) => s.setupStatus);
  if (status.phase === "idle" && !status.text) return null;
  return (
    <div class={`setup-status${status.phase === "idle" ? " warn" : ""}`} role="status">
      {status.phase !== "idle" ? <Spinner /> : <Icon name="warning" />}
      <span>{status.text}</span>
    </div>
  );
}

function LoginCard() {
  const loginUrl = useSelector((s) => s.session.loginUrl);
  const busy = useSelector((s) => s.setupStatus.phase !== "idle");
  return (
    <div class="card setup-card" role="region" aria-labelledby="setup-title">
      <div class="card-title">
        <Icon name="account" />
        <span id="setup-title">Sign in to Cursor</span>
      </div>
      <p class="setup-text">The Cursor Agent CLI is installed on this machine but not logged in. Sign in once and the extension will connect.</p>
      <StatusLine />
      <div class="card-actions">
        <button type="button" class="button primary" disabled={busy} onClick={() => post({ type: "setup.login" })}>
          <Icon name="sign-in" /> Log in
        </button>
        {loginUrl && (
          <button type="button" class="button secondary" onClick={() => post({ type: "openExternal", url: loginUrl })}>
            <Icon name="link-external" /> Open login page
          </button>
        )}
        <button type="button" class="button secondary" onClick={() => post({ type: "session.reconnect" })}>
          <Icon name="plug" /> Connect
        </button>
      </div>
    </div>
  );
}

export function SetupCard() {
  const settings = useSelector((s) => s.extSettings);
  const probe = useSelector((s) => s.probe);
  const authRequired = useSelector((s) => s.session.authRequired);
  const busy = useSelector((s) => s.setupStatus.phase !== "idle");
  useEffect(() => {
    if (!settings) post({ type: "settings.get" });
    if (!probe) post({ type: "settings.probe" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (authRequired) return <LoginCard />;

  const notFound = !probe || probe.state === "notFound" || probe.state === "checking";
  return (
    <div class="card setup-card" role="region" aria-labelledby="setup-title">
      <div class="card-title">
        <Icon name="rocket" />
        <span id="setup-title">Set up Cursor Agent</span>
      </div>
      <p class="setup-text">
        {notFound ? (
          <>The Cursor Agent CLI was not found on this machine. Install it, or point the extension at the executable (or a wrapper script) if it lives somewhere unusual.</>
        ) : (
          <>The Cursor Agent CLI could not be started. Check the path below, or reinstall it.</>
        )}
      </p>
      <StatusLine />
      <div class="card-actions">
        <button type="button" class="button primary" disabled={busy} onClick={() => post({ type: "setup.install" })}>
          <Icon name="cloud-download" /> Install Cursor Agent
        </button>
        <button type="button" class="button secondary" onClick={() => post({ type: "session.reconnect" })}>
          <Icon name="plug" /> Connect
        </button>
        <button type="button" class="button secondary" onClick={() => setSettingsOpen(true)}>
          All settings
        </button>
      </div>
      <details class="setup-advanced">
        <summary>Use a custom path</summary>
        <label class="setting-label" for="setup-agentPath">
          Agent path
        </label>
        <AgentPathControl id="setup-agentPath" settingKey={settings?.agentPathKey ?? "agentPath"} value={settings ? settings[settings.agentPathKey] : ""} />
      </details>
    </div>
  );
}
