/**
 * Setting rows bound to `cursorAcp.*` keys, plus the agent path control and
 * probe status the chat's setup card shares.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentProbe, ExtensionSettings } from "../../../shared/protocol";
import { joinArgs, parseArgs, safeListFromRows, safeListToRows, safePatternError, sameArray, splitPastedPatterns } from "../../../shared/settingsUi";
import { useSelector } from "../../store";
import { post } from "../../vscode";
import { Icon, IconButton, Spinner } from "../ui";
import { CommitInput, Segmented, Select, SettingRow, Toggle, updateSetting, useSavedFlash } from "./controls";

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
}

// ---------------------------------------------------------------------------
// Agent executable
// ---------------------------------------------------------------------------

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

/** Agent path input with Browse / Test, shared by the settings tab and the chat's setup card. */
export function AgentPathControl({ id, settingKey, value, onSaved, showProbe = true }: { id: string; settingKey: "agentPath" | "agentPathWindows"; value: string; onSaved?: () => void; showProbe?: boolean }) {
  const probe = useSelector((s) => s.probe);
  const commit = (next: string) => {
    updateSetting(settingKey, next);
    onSaved?.();
  };
  return (
    <div class="agent-path">
      <div class="agent-path-row">
        <CommitInput id={id} value={value} placeholder={settingKey === "agentPathWindows" ? "Auto-detect: agent.exe or agent.cmd" : "Auto-detect: cursor-agent or agent"} mono onCommit={commit} />
        <button title="Pick the executable or wrapper script" type="button" class="button secondary small" onClick={() => post({ type: "settings.browseAgent" })}>
          Browse…
        </button>
        <button
          title="Check that the path resolves and reports a version"
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
      {showProbe && <ProbeStatus probe={probe} />}
    </div>
  );
}

/** Connect / Install / Log in, depending on what the probe and the session report. */
function AgentActions() {
  const probe = useSelector((s) => s.probe);
  const connection = useSelector((s) => s.session.connection);
  const authRequired = useSelector((s) => s.session.authRequired);
  const setup = useSelector((s) => s.setupStatus);
  const busy = setup.phase !== "idle";
  const missing = probe?.state === "notFound";
  const connected = connection === "ready" || connection === "running" || connection === "cancelling" || connection === "loading";
  return (
    <div class="agent-actions">
      <span class={`agent-connection ${connected ? "ok" : connection === "error" || connection === "disconnected" ? "fail" : ""}`} role="status">
        <Icon name={connected ? "pass-filled" : connection === "error" || connection === "disconnected" ? "error" : "circle-outline"} />
        {connected ? "Connected" : connection === "starting" ? "Connecting…" : authRequired ? "Not logged in" : connection === "error" ? "Could not start" : connection === "disconnected" ? "Disconnected" : "Not connected"}
      </span>
      {busy && (
        <span class="agent-setup-status" role="status">
          <Spinner /> {setup.text ?? (setup.phase === "installing" ? "Installing…" : "Logging in…")}
        </span>
      )}
      <span class="agent-actions-buttons">
        {missing && (
          <button title="Run Cursor's installer in a terminal" type="button" class="button primary small" disabled={busy} onClick={() => post({ type: "setup.install" })}>
            <Icon name="cloud-download" /> Install
          </button>
        )}
        {(authRequired || !missing) && (
          <button title="Run agent login in a terminal" type="button" class={`button ${authRequired ? "primary" : "secondary"} small`} disabled={busy} onClick={() => post({ type: "setup.login" })}>
            <Icon name="sign-in" /> Log in
          </button>
        )}
        <button title={connected ? "Restart the agent with the current settings" : "Start the agent"} type="button" class="button secondary small" onClick={() => post({ type: "session.reconnect" })}>
          <Icon name={connected ? "refresh" : "plug"} /> {connected ? "Reconnect" : "Connect"}
        </button>
      </span>
    </div>
  );
}

export function AgentPathRow({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
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
          The Cursor Agent CLI or a wrapper script; empty auto-detects it. The extension runs <code>&lt;path&gt; [args…] acp</code> on the machine that hosts the workspace
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
      <AgentActions />
    </SettingRow>
  );
}

export function AgentArgsRow({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
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
      wide
      control={
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
      }
    />
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
  const listRef = useRef<HTMLDivElement>(null);
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
  const field = (r: Row, which: "key" | "value") => (
    <input
      type="text"
      class="text-input mono"
      placeholder={which === "key" ? "NAME" : "value"}
      aria-label={which === "key" ? "Variable name" : `Value of ${r.key || "variable"}`}
      value={r[which]}
      spellcheck={false}
      onFocus={() => (editing.current = true)}
      onInput={(e) => patch(r.id, which, (e.currentTarget as HTMLInputElement).value)}
      onBlur={() => {
        editing.current = false;
        commit();
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );

  return (
    <div class="env-editor" ref={listRef}>
      {rows.length === 0 && <div class="list-empty">No extra variables.</div>}
      {rows.map((r) => (
        <div key={r.id} class="env-row">
          {field(r, "key")}
          <span class="env-eq" aria-hidden="true">
            =
          </span>
          {field(r, "value")}
          <IconButton icon="trash" label={`Remove ${r.key || "variable"}`} onClick={() => remove(r.id)} />
        </div>
      ))}
      <button
        title="Add an environment variable"
        type="button"
        class="button secondary small list-add"
        onClick={() => {
          const id = ++seq.current;
          setRows([...rowsRef.current, { key: "", value: "", id }]);
          requestAnimationFrame(() => {
            const inputs = listRef.current?.querySelectorAll<HTMLInputElement>(".env-row input");
            inputs?.[inputs.length - 2]?.focus();
          });
        }}
      >
        <Icon name="add" /> Add variable
      </button>
    </div>
  );
}

export function EnvRow({ settings, onSaved }: { settings: ExtensionSettings; onSaved: () => void }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow id="setting-environment" labelFor={false} settingKey="environment" label="Environment variables" description="Extra environment variables for the agent process. Values override the extension host environment." source={settings.sources.environment} saved={saved}>
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
// Generic rows
// ---------------------------------------------------------------------------

type BoolKey = "resumeLastSession" | "showThoughts" | "notifyWhenHidden" | "editorTitleButton" | "protocolLogging" | "mcpForwardProjectServers";

export function BoolRow({ settings, k, label, description }: { settings: ExtensionSettings; k: BoolKey; label: string; description: ComponentChildren }) {
  const [saved, flash] = useSavedFlash();
  const id = `setting-${k}`;
  return (
    <SettingRow
      id={id}
      settingKey={k}
      label={label}
      description={description}
      source={settings.sources[k]}
      saved={saved}
      control={
        <Toggle
          id={id}
          checked={settings[k] ?? false}
          describedBy={`${id}-desc`}
          onChange={(v) => {
            updateSetting(k, v);
            flash();
          }}
        />
      }
    />
  );
}

export function TextRow({ settings, k, label, description, placeholder, mono, onSaved }: { settings: ExtensionSettings; k: "configDir" | "mcpUserConfig"; label: string; description: ComponentChildren; placeholder?: string; mono?: boolean; onSaved?: () => void }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow
      id={`setting-${k}`}
      settingKey={k}
      label={label}
      description={description}
      source={settings.sources[k]}
      saved={saved}
      wide
      control={
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
      }
    />
  );
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function SendShortcutRow({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  const modifier = IS_MAC ? "Cmd" : "Ctrl";
  return (
    <SettingRow
      id="setting-sendWithCtrlEnter"
      settingKey="sendWithCtrlEnter"
      label="Send shortcut"
      description={`Which key sends a message. With ${modifier}+Enter, Enter inserts a new line; with Enter, Shift+Enter does.`}
      source={settings.sources.sendWithCtrlEnter}
      saved={saved}
      control={
        <Select
          id="setting-sendWithCtrlEnter"
          value={settings.sendWithCtrlEnter ? "ctrl" : "enter"}
          options={[
            { value: "enter", label: "Enter" },
            { value: "ctrl", label: `${modifier}+Enter` },
          ]}
          onChange={(v) => {
            updateSetting("sendWithCtrlEnter", v === "ctrl");
            flash();
          }}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export function ApprovalPolicyRow({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  return (
    <SettingRow
      id="setting-approvalPolicy"
      settingKey="approvalPolicy"
      label="Default policy"
      description="What new sessions ask before running. Change it per session from the chat toolbar. Nothing is written to Cursor's own permission config."
      source={settings.sources.approvalPolicy}
      saved={saved}
      control={
        <Segmented
          id="setting-approvalPolicy"
          label="Default approval policy"
          value={settings.approvalPolicy}
          options={[
            { value: "ask", label: "Ask", hint: "Prompt for every command and tool call" },
            { value: "safe", label: "Safe list", hint: "Run commands and tools that match the safe list without asking; prompt for the rest" },
            { value: "auto", label: "Auto", hint: "Run everything without asking" },
          ]}
          onChange={(v) => {
            updateSetting("approvalPolicy", v);
            flash();
          }}
        />
      }
    />
  );
}

/** The safe list as one pattern per row. Rows commit on blur / Enter; invalid patterns are flagged but kept. */
export function SafeListEditor({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  type Row = { id: number; pattern: string };
  const seq = useRef(0);
  const toRows = (list: ReadonlyArray<unknown>): Row[] => safeListToRows(list).map((pattern) => ({ id: ++seq.current, pattern }));
  const [rows, setRowsState] = useState<Row[]>(() => toRows(settings.safeList));
  const rowsRef = useRef(rows);
  const setRows = (next: Row[]) => {
    rowsRef.current = next;
    setRowsState(next);
  };
  const editing = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing.current) setRows(toRows(settings.safeList));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.safeList]);

  const commit = () => {
    const next = safeListFromRows(rowsRef.current.map((r) => r.pattern));
    if (!sameArray(next, settings.safeList)) {
      updateSetting("safeList", next);
      flash();
    }
  };
  const focusRow = (index: number) => requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLInputElement>(".safe-row input")[index]?.focus());
  const add = (after?: number) => {
    const row = { id: ++seq.current, pattern: "" };
    const next = [...rowsRef.current];
    const at = after === undefined ? next.length : after + 1;
    next.splice(at, 0, row);
    setRows(next);
    focusRow(at);
  };
  const remove = (id: number) => {
    setRows(rowsRef.current.filter((r) => r.id !== id));
    commit();
  };
  const overridden = settings.sources.safeList && settings.sources.safeList !== "default";

  return (
    <SettingRow
      id="safe-list-first"
      label="Patterns"
      description={
        <>
          One regular expression per row; a command runs without asking only if every part of it matches.
          <details class="srow-details">
            <summary>How matching works</summary>
            <ul>
              <li>
                A shell command is split on <code>|</code>, <code>&amp;&amp;</code>, <code>||</code> and <code>;</code>; each part must match some pattern.
              </li>
              <li>
                MCP and other tools are matched by Cursor's permission pattern, such as <code>Mcp(server:tool)</code>.
              </li>
              <li>
                Commands with redirection, <code>$(…)</code> or an inline shell always ask.
              </li>
              <li>
                Patterns match anywhere in the text; start with <code>^</code> to anchor at the start of the command.
              </li>
            </ul>
          </details>
        </>
      }
      settingKey="safeList"
      source={settings.sources.safeList}
      saved={saved}
    >
      <div class="safe-list" ref={listRef}>
        {rows.length === 0 && <div class="list-empty">No patterns: under the Safe list policy everything asks.</div>}
        {rows.map((r, i) => {
          const error = safePatternError(r.pattern);
          return (
            <div key={r.id} class={`safe-row${error ? " invalid" : ""}`}>
              <input
                id={i === 0 ? "safe-list-first" : undefined}
                type="text"
                class="text-input mono"
                value={r.pattern}
                placeholder="^command\b"
                aria-label={`Pattern ${i + 1}`}
                aria-invalid={error ? true : undefined}
                title={error ? `Not a valid regular expression: ${error}. It is ignored until fixed.` : undefined}
                spellcheck={false}
                onFocus={() => (editing.current = true)}
                onInput={(e) => setRows(rowsRef.current.map((x) => (x.id === r.id ? { ...x, pattern: (e.currentTarget as HTMLInputElement).value } : x)))}
                onPaste={(e) => {
                  const text = e.clipboardData?.getData("text/plain") ?? "";
                  const lines = splitPastedPatterns(text);
                  if (lines.length < 2) return;
                  e.preventDefault();
                  const next = [...rowsRef.current];
                  const at = next.findIndex((x) => x.id === r.id);
                  const replaceCurrent = !r.pattern.trim();
                  next.splice(replaceCurrent ? at : at + 1, replaceCurrent ? 1 : 0, ...lines.map((pattern) => ({ id: ++seq.current, pattern })));
                  setRows(next);
                  commit();
                }}
                onBlur={() => {
                  editing.current = false;
                  commit();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                    add(i);
                  }
                }}
              />
              {error && <Icon name="warning" class="safe-row-warning" title={`Invalid: ${error}`} />}
              <IconButton icon="trash" label="Remove pattern" onClick={() => remove(r.id)} />
            </div>
          );
        })}
        <div class="list-actions">
          <button title="Add a pattern" type="button" class="button secondary small" onClick={() => add()}>
            <Icon name="add" /> Add pattern
          </button>
          {overridden && (
            <button title="Replace your patterns with the built-in read-only list" type="button" class="button tertiary small" onClick={() => post({ type: "settings.reset", key: "safeList" })}>
              <Icon name="discard" /> Reset to defaults
            </button>
          )}
        </div>
      </div>
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export function ModelDefaultsRow({ settings }: { settings: ExtensionSettings }) {
  const [saved, flash] = useSavedFlash();
  const models = useSelector((s) => s.session.models);
  const modelOptions = useSelector((s) => s.session.modelOptions);
  const name = settings.defaultModel ? (models?.availableModels.find((m) => m.modelId === settings.defaultModel)?.name ?? settings.defaultModel) : "Cursor's current default";
  const opts = Object.entries(settings.defaultModelOptions ?? {});
  const currentName = models ? (models.availableModels.find((m) => m.modelId === models.currentModelId)?.name ?? models.currentModelId) : undefined;
  return (
    <>
      <SettingRow
        id="setting-defaultModel"
        labelFor={false}
        settingKey="defaultModel"
        label="Model"
        description="The model every new session starts with."
        source={settings.sources.defaultModel}
        saved={saved}
        control={
          <span class={`srow-plain-value${settings.defaultModel ? "" : " empty"}`} aria-labelledby="setting-defaultModel-label">
            {name}
          </span>
        }
      />
      <SettingRow
        id="setting-defaultModelOptions"
        labelFor={false}
        settingKey="defaultModelOptions"
        label="Options"
        description="Effort, context and other option values applied to new sessions."
        source={settings.sources.defaultModelOptions}
        control={
          opts.length ? (
            <span class="srow-chips" role="list" aria-labelledby="setting-defaultModelOptions-label">
              {opts.map(([k, v]) => (
                <span key={k} class="chip" role="listitem">
                  {k}: {typeof v === "boolean" ? (v ? "on" : "off") : v}
                </span>
              ))}
            </span>
          ) : (
            <span class="srow-plain-value empty">none</span>
          )
        }
      />
      <SettingRow
        id="setting-defaultModel-use"
        labelFor={false}
        label="Change defaults"
        description="Changes made inside a session apply to that session only."
        control={
          <>
        <button
          id="setting-defaultModel-use"
          title={currentName ? `Use ${currentName}${modelOptions.length ? " and its current options" : ""} for new sessions` : "Connect to a session first"}
          type="button"
          class="button secondary small"
          disabled={!models}
          onClick={() => {
            post({ type: "model.saveDefault" });
            flash();
          }}
        >
          <Icon name="pin" /> Use the current session's model{modelOptions.length ? " and options" : ""}
        </button>
        {(settings.defaultModel || opts.length > 0) && (
          <button
            title="Let new sessions use whatever the Cursor CLI defaults to"
            type="button"
            class="button secondary small"
            onClick={() => {
              updateSetting("defaultModel", "");
              updateSetting("defaultModelOptions", {});
              flash();
            }}
          >
            <Icon name="discard" /> Clear
          </button>
        )}
          </>
        }
      />
    </>
  );
}
