import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentProbe, ExtensionSettings, SettingsKey } from "../../shared/protocol";
import { setModelsOpen, setSettingsOpen, useSelector } from "../store";
import { post } from "../vscode";
import { Icon, IconButton, Spinner } from "./ui";

type Source = ExtensionSettings["sources"][string];
type SettingValue = string | boolean | ReadonlyArray<string> | Readonly<Record<string, string>>;

const SOURCE_LABEL: Record<Exclude<Source, "default">, string> = { user: "User", workspace: "Workspace", remote: "Remote" };

function updateSetting(key: SettingsKey, value: SettingValue): void {
  post({ type: "settings.update", key, value });
}

/** Split a command line on whitespace, honouring simple single/double quotes. */
export function parseArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    if (token.length) out.push(token);
  }
  return out;
}

export function joinArgs(args: ReadonlyArray<string>): string {
  return args.map((a) => (/\s|"/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a === "" ? '""' : a)).join(" ");
}

function sameArray(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
}

/** Shows "Saved" for a moment after a successful update. */
function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = () => {
    setSaved(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(false), 1600);
  };
  return [saved, flash];
}

// ---------------------------------------------------------------------------
// Row chrome
// ---------------------------------------------------------------------------

interface RowProps {
  id: string;
  settingKey: SettingsKey;
  label: string;
  description?: ComponentChildren;
  source?: Source;
  saved: boolean;
  /** Control rendered on the right of the label row (checkbox); otherwise below. */
  inline?: ComponentChildren;
  children?: ComponentChildren;
}

function SettingRow({ id, settingKey, label, description, source, saved, inline, children }: RowProps) {
  const overridden = !!source && source !== "default";
  return (
    <div class={`setting-row${inline ? " inline" : ""}`}>
      <div class="setting-head">
        <label class="setting-label" for={id}>
          {label}
        </label>
        {overridden && <span class="setting-source">{SOURCE_LABEL[source]}</span>}
        <span class={`setting-saved${saved ? " show" : ""}`} aria-live="polite">
          {saved ? "Saved" : ""}
        </span>
        {overridden && (
          <button type="button" class="setting-reset" title="Reset to default" onClick={() => post({ type: "settings.reset", key: settingKey })}>
            <Icon name="discard" /> Reset
          </button>
        )}
        {inline && <div class="setting-inline-control">{inline}</div>}
      </div>
      {description && <div class="setting-desc">{description}</div>}
      {children && <div class="setting-control">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

interface TextInputProps {
  id: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  ariaLabel?: string;
  onCommit: (next: string) => void;
}

/** Text input that commits on blur / Enter and reverts on Escape. */
export function CommitInput({ id, value, placeholder, mono, ariaLabel, onCommit }: TextInputProps) {
  const [draft, setDraft] = useState(value);
  // Latest draft, readable synchronously from event handlers (state may lag a render).
  const draftRef = useRef(value);
  const focused = useRef(false);
  const set = (v: string) => {
    draftRef.current = v;
    setDraft(v);
  };
  useEffect(() => {
    if (!focused.current) set(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = () => {
    if (draftRef.current !== value) onCommit(draftRef.current);
  };
  return (
    <input
      id={id}
      type="text"
      class={`text-input${mono ? " mono" : ""}`}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellcheck={false}
      onFocus={() => (focused.current = true)}
      onInput={(e) => set((e.currentTarget as HTMLInputElement).value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draftRef.current !== value) {
          e.stopPropagation();
          set(value);
        }
      }}
    />
  );
}

export function Checkbox({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button id={id} type="button" role="checkbox" aria-checked={checked} aria-label={label} title={label} class={`checkbox${checked ? " checked" : ""}`} onClick={() => onChange(!checked)}>
      {checked && <Icon name="check" />}
    </button>
  );
}

export function ProbeStatus({ probe }: { probe: AgentProbe | undefined }) {
  if (!probe) return null;
  switch (probe.state) {
    case "checking":
      return (
        <div class="probe-status checking" role="status">
          <Spinner /> <span>Checking…</span>
        </div>
      );
    case "ok":
      return (
        <div class="probe-status ok" role="status">
          <Icon name="check" />
          <span>
            Found <code>{probe.resolvedPath ?? probe.configuredPath}</code>
            {probe.version ? ` · version ${probe.version}` : ""}
          </span>
        </div>
      );
    default:
      return (
        <div class="probe-status fail" role="alert">
          <Icon name="error" />
          <span>
            {probe.error ?? (probe.state === "notFound" ? `Executable not found: ${probe.configuredPath}` : "Agent check failed")}
            {probe.hint && <span class="probe-hint">{probe.hint}</span>}
          </span>
        </div>
      );
  }
}

/** Agent path input with Browse / Test, shared by the settings panel and the setup card. */
export function AgentPathControl({ id, settingKey, value, onSaved }: { id: string; settingKey: "agentPath" | "agentPathWindows"; value: string; onSaved?: () => void }) {
  const probe = useSelector((s) => s.probe);
  const commit = (next: string) => {
    updateSetting(settingKey, next);
    onSaved?.();
  };
  return (
    <div class="agent-path">
      <div class="agent-path-row">
        <CommitInput id={id} value={value} placeholder={settingKey === "agentPathWindows" ? "Auto-detect: agent.exe or agent.cmd" : "Auto-detect: cursor-agent or agent"} mono ariaLabel="Agent executable path" onCommit={commit} />
        <button title="Pick the executable or wrapper script" type="button" class="button secondary small" onClick={() => post({ type: "settings.browseAgent" })}>
          Browse…
        </button>
        <button title="Check that the path resolves and reports a version"
          type="button"
          class="button secondary small"
          disabled={probe?.state === "checking"}
          onClick={() => {
            // Commit a pending edit first so the probe tests what is saved.
            (document.getElementById(id) as HTMLInputElement | null)?.blur();
            post({ type: "settings.probe" });
          }}
        >
          Test
        </button>
      </div>
      <ProbeStatus probe={probe} />
    </div>
  );
}

function EnvEditor({ value, onCommit }: { value: Readonly<Record<string, string>>; onCommit: (next: Record<string, string>) => void }) {
  type Row = { key: string; value: string; id: number };
  const seq = useRef(0);
  const toRows = (rec: Readonly<Record<string, string>>): Row[] => Object.entries(rec).map(([k, v]) => ({ key: k, value: v, id: ++seq.current }));
  const [rows, setRowsState] = useState<Row[]>(() => toRows(value));
  // Latest rows, readable synchronously from blur handlers.
  const rowsRef = useRef(rows);
  const setRows = (next: Row[]) => {
    rowsRef.current = next;
    setRowsState(next);
  };
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setRows(toRows(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    const rec: Record<string, string> = {};
    for (const r of rowsRef.current) {
      const k = r.key.trim();
      if (k) rec[k] = r.value;
    }
    if (!sameRecord(rec, value)) onCommit(rec);
  };
  const patch = (id: number, field: "key" | "value", v: string) => setRows(rowsRef.current.map((r) => (r.id === id ? { ...r, [field]: v } : r)));
  const remove = (id: number) => {
    setRows(rowsRef.current.filter((r) => r.id !== id));
    commit();
  };

  return (
    <div class="env-editor">
      {rows.map((r) => (
        <div key={r.id} class="env-row">
          <input
            type="text"
            class="text-input mono"
            placeholder="NAME"
            aria-label="Variable name"
            value={r.key}
            spellcheck={false}
            onFocus={() => (editing.current = true)}
            onInput={(e) => patch(r.id, "key", (e.currentTarget as HTMLInputElement).value)}
            onBlur={() => {
              editing.current = false;
              commit();
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          />
          <span class="env-eq" aria-hidden="true">
            =
          </span>
          <input
            type="text"
            class="text-input mono"
            placeholder="value"
            aria-label="Variable value"
            value={r.value}
            spellcheck={false}
            onFocus={() => (editing.current = true)}
            onInput={(e) => patch(r.id, "value", (e.currentTarget as HTMLInputElement).value)}
            onBlur={() => {
              editing.current = false;
              commit();
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          />
          <IconButton icon="close" label={`Remove ${r.key || "variable"}`} onClick={() => remove(r.id)} />
        </div>
      ))}
      <button title="Add an environment variable"
        type="button"
        class="link-button env-add"
        onClick={() => {
          const id = ++seq.current;
          setRows([...rowsRef.current, { key: "", value: "", id }]);
          requestAnimationFrame(() => {
            const inputs = document.querySelectorAll<HTMLInputElement>(".env-editor .env-row input");
            inputs[inputs.length - 2]?.focus();
          });
        }}
      >
        <Icon name="add" /> Add variable
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows bound to settings keys
// ---------------------------------------------------------------------------

function TextRow({ settings, k, label, description, placeholder, mono, onSaved }: { settings: ExtensionSettings; k: "configDir"; label: string; description: ComponentChildren; placeholder?: string; mono?: boolean; onSaved?: () => void }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow id={`setting-${k}`} settingKey={k} label={label} description={description} source={settings.sources[k]} saved={saved}>
      <CommitInput
        id={`setting-${k}`}
        value={settings[k]}
        placeholder={placeholder}
        mono={mono}
        onCommit={(v) => {
          updateSetting(k, v);
          flash();
          onSaved?.();
        }}
      />
    </SettingRow>
  );
}

function ApprovalPolicyRow({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow
      id="setting-approvalPolicy"
      settingKey="approvalPolicy"
      label="Approvals"
      description="Default for new sessions; change it per session from the chat toolbar. Nothing is written to Cursor's own permission config."
      source={settings.sources.approvalPolicy}
      saved={saved}
      inline={
        <select
          id="setting-approvalPolicy"
          class="select-input"
          value={settings.approvalPolicy}
          onChange={(e) => {
            updateSetting("approvalPolicy", (e.currentTarget as HTMLSelectElement).value);
            flash();
          }}
        >
          <option value="ask">Ask</option>
          <option value="safe">Safe list</option>
          <option value="auto">Auto</option>
        </select>
      }
    />
  );
}

function SafeListRow({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  const [draft, setDraft] = useState((settings.safeList ?? []).join("\n"));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft((settings.safeList ?? []).join("\n"));
  }, [settings.safeList]);
  const commit = () => {
    const next = draft.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!sameArray(next, settings.safeList ?? [])) {
      updateSetting("safeList", next);
      flash();
    }
  };
  return (
    <SettingRow
      id="setting-safeList"
      settingKey="safeList"
      label="Safe list"
      description={
        <>
          One regular expression per line. Tested against each part of a shell command (split on <code>|</code>, <code>&amp;&amp;</code>, <code>;</code>) and against Cursor's tool pattern such as <code>Mcp(server:tool)</code>. Commands using redirection, <code>$(…)</code> or an inline shell always ask.
        </>
      }
      source={settings.sources.safeList}
      saved={saved}
    >
      <textarea
        id="setting-safeList"
        class="text-input mono safe-list-input"
        rows={8}
        spellcheck={false}
        value={draft}
        onFocus={() => (focused.current = true)}
        onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
      />
    </SettingRow>
  );
}

function ModelDefaultsRow({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  const models = useSelector((s) => s.session.models);
  const modelOptions = useSelector((s) => s.session.modelOptions);
  const name = settings.defaultModel ? (models?.availableModels.find((m) => m.modelId === settings.defaultModel)?.name ?? settings.defaultModel) : "Cursor's current default";
  const opts = Object.entries(settings.defaultModelOptions ?? {});
  const currentName = models ? (models.availableModels.find((m) => m.modelId === models.currentModelId)?.name ?? models.currentModelId) : undefined;
  return (
    <SettingRow
      id="setting-defaultModel"
      settingKey="defaultModel"
      label="Defaults for new sessions"
      description="Every new session starts with this model and these options. Changes made inside a session apply to that session only."
      source={settings.sources.defaultModel !== "default" ? settings.sources.defaultModel : settings.sources.defaultModelOptions}
      saved={saved}
    >
      <div class="model-defaults">
        <div class="model-defaults-line">
          <span class="model-defaults-key">Model</span>
          <span class="model-defaults-value">{name}</span>
        </div>
        <div class="model-defaults-line">
          <span class="model-defaults-key">Options</span>
          <span class="model-defaults-value">{opts.length ? opts.map(([k, v]) => `${k}: ${typeof v === "boolean" ? (v ? "on" : "off") : v}`).join(" · ") : "none"}</span>
        </div>
        <div class="settings-links">
          <button
            title={currentName ? `Use ${currentName}${modelOptions.length ? " and its current options" : ""} for new sessions` : "Connect to a session first"}
            type="button"
            class="link-button"
            disabled={!models}
            onClick={() => {
              post({ type: "model.saveDefault" });
              flash();
            }}
          >
            <Icon name="pin" /> Use the current session's model and options
          </button>
          {(settings.defaultModel || opts.length > 0) && (
            <button
              title="Let new sessions use whatever the Cursor CLI defaults to"
              type="button"
              class="link-button"
              onClick={() => {
                updateSetting("defaultModel", "");
                updateSetting("defaultModelOptions", {});
                flash();
              }}
            >
              <Icon name="discard" /> Clear
            </button>
          )}
        </div>
      </div>
    </SettingRow>
  );
}

type BoolKey = "resumeLastSession" | "sendWithCtrlEnter" | "showThoughts" | "notifyWhenHidden" | "protocolLogging";

function BoolRow({ settings, k, label, description }: { settings: ExtensionSettings; k: BoolKey; label: string; description: ComponentChildren }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow
      id={`setting-${k}`}
      settingKey={k}
      label={label}
      description={description}
      source={settings.sources[k]}
      saved={saved}
      inline={
        <Checkbox
          id={`setting-${k}`}
          checked={settings[k]}
          label={label}
          onChange={(v) => {
            updateSetting(k, v);
            flash();
          }}
        />
      }
    />
  );
}

function AgentPathRow({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
  const [saved, flash] = useSavedFlash();
  const key = settings.agentPathKey;
  const windows = key === "agentPathWindows";
  return (
    <SettingRow
      id="setting-agentPath"
      settingKey={key}
      label={windows ? "Agent path (Windows)" : "Agent path"}
      description={
        <>
          Path to the Cursor Agent CLI (or a wrapper script). The extension runs <code>&lt;path&gt; [args…] acp</code>. Resolved on the machine that hosts the workspace
          {windows ? "; this Windows-only key is ignored by WSL and remote windows, which use their own." : "."}
        </>
      }
      source={settings.sources[key]}
      saved={saved}
    >
      <AgentPathControl
        id="setting-agentPath"
        settingKey={key}
        value={settings[key]}
        onSaved={() => {
          flash();
          onSaved();
        }}
      />
    </SettingRow>
  );
}

function AgentArgsRow({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow
      id="setting-agentArgs"
      settingKey="agentArgs"
      label="Agent arguments"
      description={
        <>
          Extra arguments passed before <code>acp</code>. Quote values containing spaces.
        </>
      }
      source={settings.sources.agentArgs}
      saved={saved}
    >
      <CommitInput
        id="setting-agentArgs"
        value={joinArgs(settings.agentArgs)}
        placeholder='-e "https://api2.cursor.sh"'
        mono
        onCommit={(v) => {
          const next = parseArgs(v);
          if (sameArray(next, settings.agentArgs)) return;
          updateSetting("agentArgs", next);
          flash();
          onSaved();
        }}
      />
    </SettingRow>
  );
}

function EnvRow({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow id="setting-environment" settingKey="environment" label="Environment" description="Extra environment variables for the agent process. Values override the extension host environment." source={settings.sources.environment} saved={saved}>
      <EnvEditor
        value={settings.environment}
        onCommit={(rec) => {
          updateSetting("environment", rec);
          flash();
          onSaved();
        }}
      />
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

type SettingsTab = "agent" | "approvals" | "models" | "behaviour" | "advanced";

export function SettingsView() {
  const settings = useSelector((s) => s.extSettings);
  const [connectionChanged, setConnectionChanged] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const markConnectionChange = () => setConnectionChanged(true);

  useEffect(() => {
    post({ type: "settings.get" });
    post({ type: "settings.probe" });
    backRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest(".popover")) return;
      e.preventDefault();
      setSettingsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const [tab, setTab] = useState<SettingsTab>("agent");
  const tabs: ReadonlyArray<{ id: SettingsTab; label: string; hint: string }> = [
    { id: "agent", label: "Agent", hint: "Where the Cursor CLI is and how it is launched" },
    { id: "approvals", label: "Approvals", hint: "What runs without asking" },
    { id: "models", label: "Models", hint: "Defaults for new sessions and which models are shown" },
    { id: "behaviour", label: "Behaviour", hint: "Resume, send key, thinking blocks, notifications" },
    { id: "advanced", label: "Advanced", hint: "Logging and raw settings" },
  ];
  const onTabKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
      setTab(next.id);
      requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus());
    }
  };

  return (
    <div class="settings-view" role="region" aria-label="Settings">
      <div class="settings-top">
        <IconButton ref={backRef} icon="arrow-left" label="Back to chat" onClick={() => setSettingsOpen(false)} />
        <h2 class="settings-title">Settings</h2>
      </div>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`settings-tab-${t.id}`}
            type="button"
            role="tab"
            class={`settings-tab${tab === t.id ? " active" : ""}`}
            aria-selected={tab === t.id}
            aria-controls={`settings-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            title={t.hint}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div class="settings-scroll" id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {!settings ? (
          <div class="settings-loading">
            <Spinner /> Loading settings…
          </div>
        ) : (
          <>
            {tab === "agent" && (
            <section class="settings-section" aria-labelledby="settings-agent">
              <h3 id="settings-agent" class="settings-heading">
                Agent
              </h3>
              <AgentPathRow settings={settings} onSaved={markConnectionChange} />
              <AgentArgsRow settings={settings} onSaved={markConnectionChange} />
              <EnvRow settings={settings} onSaved={markConnectionChange} />
              <TextRow settings={settings} k="configDir" label="Config directory" description="Cursor's config directory. Only used by the usage panel to read local usage data; leave empty to use the default location." placeholder="~/.cursor" mono />
            </section>
            )}

            {tab === "approvals" && (
            <section class="settings-section" aria-labelledby="settings-approvals">
              <h3 id="settings-approvals" class="settings-heading">
                Approvals
              </h3>
              <ApprovalPolicyRow settings={settings} />
              <SafeListRow settings={settings} />
            </section>
            )}

            {tab === "models" && (
            <section class="settings-section" aria-labelledby="settings-models">
              <h3 id="settings-models" class="settings-heading">
                Models
              </h3>
              <ModelDefaultsRow settings={settings} />
              <div class="settings-links">
                <button title="Choose which models appear in the picker" type="button" class="link-button" onClick={() => setModelsOpen(true)}>
                  <Icon name="list-selection" /> Manage visible models
                </button>
              </div>
            </section>
            )}

            {tab === "behaviour" && (
            <section class="settings-section" aria-labelledby="settings-behaviour">
              <h3 id="settings-behaviour" class="settings-heading">
                Behaviour
              </h3>
              <BoolRow settings={settings} k="resumeLastSession" label="Resume last session" description="Automatically resume the last session for this workspace when the chat opens." />
              <BoolRow settings={settings} k="sendWithCtrlEnter" label="Send with Ctrl/Cmd+Enter" description="Use Ctrl/Cmd+Enter to send. Enter then inserts a newline." />
              <BoolRow settings={settings} k="showThoughts" label="Show thinking" description="Show the agent's reasoning blocks in the transcript." />
              <BoolRow settings={settings} k="notifyWhenHidden" label="Notify when hidden" description="Show a VS Code notification when the agent needs permission or finishes while the chat is not visible." />
            </section>
            )}

            {tab === "advanced" && (
            <section class="settings-section" aria-labelledby="settings-advanced">
              <h3 id="settings-advanced" class="settings-heading">
                Advanced
              </h3>
              <BoolRow settings={settings} k="protocolLogging" label="Protocol logging" description="Log every ACP JSON-RPC message to the Cursor Agent output channel." />
              <div class="settings-links">
                <button title="Open the Cursor Agent output channel" type="button" class="link-button" onClick={() => post({ type: "openLogs" })}>
                  <Icon name="output" /> Open logs
                </button>
                <button title="Edit these settings as JSON" type="button" class="link-button" onClick={() => post({ type: "openSettings" })}>
                  <Icon name="json" /> Open settings.json
                </button>
              </div>
            </section>
            )}

            {connectionChanged && tab === "agent" && (
              <div class="settings-footer" role="status">
                <Icon name="info" />
                <span>Changes to the agent path, arguments or environment take effect on the next connection.</span>
                <button title="Restart the agent with the new settings" type="button" class="button secondary small" onClick={() => post({ type: "session.reconnect" })}>
                  <Icon name="refresh" /> Reconnect now
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
