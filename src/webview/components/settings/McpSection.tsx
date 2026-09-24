import { useEffect, useState } from "preact/hooks";
import type { ExtensionSettings, McpCliServer, McpPluginServer, McpStatus, McpUserConfigSource } from "../../../shared/protocol";
import { mcpNeedsApproval as needsApproval } from "../../../shared/settingsUi";
import { getState, useSelector } from "../../store";
import { post } from "../../vscode";
import { Icon, IconButton, Spinner } from "../ui";
import { Segmented, SettingRow, SettingsGroup, Toggle, updateSetting } from "./controls";
import { BoolRow, TextRow } from "./rows";

const TRANSPORT_LABEL = { stdio: "stdio", http: "HTTP", sse: "SSE" } as const;

/** Rough health of a CLI status string, for the dot colour only; the text is always shown. */
function tone(server: McpCliServer): "ok" | "warn" | "fail" | "muted" {
  const s = server.status.toLowerCase();
  if (needsApproval(server)) return server.forwarded ? "ok" : "warn";
  if (/error|fail|unreachable|crash/.test(s)) return "fail";
  if (/disabled|off|skipped/.test(s)) return "muted";
  if (/ready|connected|ok|running|enabled|loaded|available/.test(s)) return "ok";
  return "muted";
}

// ---------------------------------------------------------------------------
// Cursor plugins
// ---------------------------------------------------------------------------

const SOURCE_TEXT: Record<McpUserConfigSource, string> = {
  settings: "from settings",
  environment: "from the agent environment setting",
  agent: "from the agent process",
  default: "default",
};

const MODE_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    hint: "Add every plugin server when the agent connects, except the ones switched off",
  },
  {
    value: "manual",
    label: "Manual",
    hint: "Only the switches below change mcp.json",
  },
  { value: "off", label: "Off", hint: "Leave mcp.json alone" },
] as const;

type PluginMode = (typeof MODE_OPTIONS)[number]["value"];

const MODE_DESC: Record<PluginMode, string> = {
  auto: "Every plugin server is added when the agent connects. Switching one off leaves it out and removes only an entry the extension added.",
  manual: "Nothing is added on its own; the switches below add or remove each server's entry.",
  off: "The extension leaves mcp.json alone. The list below only shows what is there.",
};

function titleCase(name: string): string {
  return name.replace(/(^|[-_\s])([a-z])/g, (_, sep: string, ch: string) => `${sep === "-" || sep === "_" ? " " : sep}${ch.toUpperCase()}`);
}

/** "Atlassian", or "Cloudflare · docs" when the plugin has several servers. */
function pluginLabel(server: McpPluginServer, several: boolean): string {
  const plugin = titleCase(server.pluginName);
  if (!several) return plugin;
  const prefix = `${server.pluginName}-`;
  return `${plugin} · ${server.serverName.startsWith(prefix) ? server.serverName.slice(prefix.length) : server.serverName}`;
}

type Chip = {
  text: string;
  tone: "ok" | "warn" | "fail" | "muted";
  title: string;
};

function needsSignIn(server: McpPluginServer): boolean {
  return !!server.cliStatus && /requires?_?auth|needs? (auth|sign|login)|unauthori[sz]ed|not (authenticated|logged)/i.test(server.cliStatus);
}

function pluginChip(server: McpPluginServer, reconnectNeeded: boolean): Chip {
  const status = server.cliStatus;
  if (!server.enabled)
    return {
      text: "Not in chat",
      tone: "muted",
      title: "Not listed in the user-level mcp.json, so the agent does not load it",
    };
  if (needsSignIn(server))
    return {
      text: "Needs sign-in",
      tone: "warn",
      title: `The agent reports "${status}" for this folder. Sign in once per project folder.`,
    };
  if (status && /error|fail|crash|unreachable/i.test(status))
    return {
      text: "Error",
      tone: "fail",
      title: `The agent reports: ${status}`,
    };
  if (status && /ready|connected|running|ok\b/i.test(status))
    return {
      text: "Ready",
      tone: "ok",
      title: `The agent reports "${status}"`,
    };
  if (status)
    return {
      text: status,
      tone: "muted",
      title: `The agent reports "${status}"`,
    };
  return {
    text: "Added",
    tone: "muted",
    title: reconnectNeeded ? "Listed in mcp.json; reconnect so the agent loads it" : "Listed in mcp.json; the agent has not reported it yet",
  };
}

const CHIP_ICON = {
  ok: "pass-filled",
  warn: "warning",
  fail: "error",
  muted: "circle-outline",
} as const;

function PluginRow({ server, several, mode, pending, reconnectNeeded, onToggle }: { server: McpPluginServer; several: boolean; mode: PluginMode; pending: boolean | undefined; reconnectNeeded: boolean; onToggle: (next: boolean) => void }) {
  const label = pluginLabel(server, several);
  const chip = pluginChip(server, reconnectNeeded);
  const on = pending ?? (mode === "auto" ? !server.excluded : server.enabled);
  const id = `mcp-plugin-${server.id}`;
  // Auto mode only removes entries it added; one written by hand stays until removed from mcp.json.
  const keptByHand = mode === "auto" && !on && server.enabled && pending === undefined;
  const toggleTitle =
    mode === "off"
      ? "Plugin servers are off; choose Automatic or Manual above"
      : keptByHand
        ? "Left out of automatic adding, but mcp.json still lists it (the extension did not add that entry). Remove it from mcp.json to take it out of chat."
        : on
          ? "Available in chat: switch off to leave it out"
          : "Not available in chat: switch on to add it to mcp.json";
  return (
    <SettingRow
      class="plugin-row"
      id={id}
      label={label}
      description={
        <span title={server.id}>
          <span class="plugin-transport">{TRANSPORT_LABEL[server.transport]}</span> · {server.host}
          {keptByHand && " · still listed in mcp.json by hand"}
        </span>
      }
      control={
        <>
          <span class={`plugin-chip ${chip.tone}`} title={chip.title}>
            <Icon name={CHIP_ICON[chip.tone]} class={`status-dot ${chip.tone}`} />
            {chip.text}
          </span>
          {needsSignIn(server) && server.enabled && (
            <button type="button" class="button secondary small" title={`Run "agent mcp login ${server.id}" in a terminal in this folder`} onClick={() => post({ type: "mcp.plugins.login", id: server.id })}>
              Sign in
            </button>
          )}
          <Toggle id={id} checked={on} disabled={mode === "off"} title={toggleTitle} onChange={onToggle} />
        </>
      }
    />
  );
}

function PluginsGroup({ status, loading, settings }: { status: McpStatus | undefined; loading: boolean; settings: ExtensionSettings }) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  // A fresh status replaces the optimistic switch positions.
  useEffect(() => setPending({}), [status]);
  const mode: PluginMode = status?.pluginMode ?? settings.mcpPluginServers ?? "auto";
  const plugins = status?.plugins ?? [];
  const perPlugin = new Map<string, number>();
  for (const p of plugins) perPlugin.set(p.pluginName, (perPlugin.get(p.pluginName) ?? 0) + 1);
  const isOn = (p: McpPluginServer) => pending[p.id] ?? (mode === "auto" ? !p.excluded : p.enabled);
  const off = plugins.filter((p) => !isOn(p));
  const set = (ids: string[], enabled: boolean) => {
    setPending((prev) => ({
      ...prev,
      ...Object.fromEntries(ids.map((id) => [id, enabled])),
    }));
    post({ type: "mcp.plugins.set", ids, enabled });
  };
  const path = status?.userConfigPath;
  return (
    <SettingsGroup
      title="Cursor plugins"
      id="mcp-plugins"
      description={
        path ? (
          <>
            MCP servers that come with your Cursor plugins. Adds them to <code>{path}</code> ({SOURCE_TEXT[status?.userConfigSource ?? "default"]}) under the plugin's name, where the agent loads them with the sign-ins Cursor saved.
          </>
        ) : (
          "MCP servers that come with your Cursor plugins, added to the agent's user-level mcp.json under the plugin's name, where the agent loads them with the sign-ins Cursor saved."
        )
      }
      actions={
        <>
          {mode !== "off" && off.length > 0 && plugins.length > 0 && (
            <button
              type="button"
              class="button secondary small"
              title="Make every plugin server available in chat"
              disabled={loading}
              onClick={() =>
                set(
                  off.map((p) => p.id),
                  true,
                )
              }
            >
              Enable all
            </button>
          )}
          <IconButton icon="go-to-file" label="Open the user-level mcp.json" disabled={!path} onClick={() => post({ type: "mcp.openUserConfig" })} />
        </>
      }
    >
      {status?.reconnectNeeded && (
        <div class="srow plugin-banner" role="status">
          <Icon name="info" />
          <span class="plugin-banner-text">mcp.json changed. The agent reads it when it starts, so reconnect to apply.</span>
          <button type="button" class="button primary small" title="Restart the agent and reopen this session" onClick={() => post({ type: "session.reconnect" })}>
            <Icon name="debug-restart" /> Reconnect
          </button>
        </div>
      )}
      <SettingRow
        id="mcp-plugin-mode"
        labelFor={false}
        label="Add plugin servers"
        description={MODE_DESC[mode]}
        control={<Segmented id="mcp-plugin-mode" label="Add plugin servers" value={mode} options={MODE_OPTIONS} onChange={(v) => updateSetting("mcpPluginServers", v)} />}
      />
      {!status ? (
        <div class="srow">
          <div class="list-empty">
            <Spinner /> Looking for Cursor plugins…
          </div>
        </div>
      ) : plugins.length === 0 ? (
        <div class="srow">
          <div class="list-empty">No Cursor plugins with MCP servers found in {status.pluginsDir ?? "the Cursor plugins folder"}.</div>
        </div>
      ) : (
        plugins.map((p) => <PluginRow key={p.id} server={p} several={(perPlugin.get(p.pluginName) ?? 0) > 1} mode={mode} pending={pending[p.id]} reconnectNeeded={!!status.reconnectNeeded} onToggle={(next) => set([p.id], next)} />)
      )}
      {status && (status.pluginErrors?.length ?? 0) > 0 && (
        <div class="srow">
          <ul class="plugin-errors" aria-label="Plugin problems">
            {status.pluginErrors!.map((e) => (
              <li key={e}>
                <Icon name="warning" />
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsGroup>
  );
}

function ForwardedList({ status }: { status: McpStatus }) {
  const broken = status.files.filter((f) => f.state === "error");
  return (
    <SettingRow
      id="mcp-forwarded"
      labelFor={false}
      label="Forwarded by the extension"
      description={
        status.projectSkipped
          ? `Project servers are not forwarded: ${status.projectSkipped}.`
          : "Passed to the agent with every session, so they work without approving them in Cursor's terminal app. Project servers win over user ones with the same name."
      }
    >
      <ul class="status-list" id="mcp-forwarded" aria-label="Forwarded servers">
        {status.forwarded.length === 0 && <li class="list-empty">None. Add servers to the project's mcp.json, or set a user-level file above.</li>}
        {status.forwarded.map((s) => (
          <li key={s.name} class="status-item">
            <Icon name="pass-filled" class="status-dot ok" />
            <span class="status-name">{s.name}</span>
            <span class="status-tag" title={s.source === "project" ? "From this workspace's .cursor/mcp.json" : "From the user-level mcp.json set above"}>
              {s.source === "project" ? "Project" : "User"}
            </span>
            <span class="status-detail" title={`${TRANSPORT_LABEL[s.transport]}: ${s.target}`}>
              {TRANSPORT_LABEL[s.transport]} · {s.target}
            </span>
          </li>
        ))}
        {broken.map((f) => (
          <li key={f.path} class="status-item">
            <Icon name="error" class="status-dot fail" />
            <span class="status-name">{f.level === "project" ? "Project mcp.json" : "User mcp.json"}</span>
            <span class="status-detail fail" title={f.path}>
              {f.detail ?? "Could not be read"}
            </span>
          </li>
        ))}
      </ul>
    </SettingRow>
  );
}

function CliList({ status }: { status: McpStatus }) {
  const cli = status.cli;
  return (
    <SettingRow
      id="mcp-cli"
      labelFor={false}
      label="Reported by the CLI"
      description={
        <>
          What <code>agent mcp list</code> says, including servers from your own <code>~/.cursor/mcp.json</code>. A project server that "needs approval" still works in chat when the extension forwards it.
        </>
      }
    >
      {"error" in cli ? (
        <div class="probe-status fail" role="alert" id="mcp-cli">
          <Icon name="error" />
          <span>{cli.error}</span>
        </div>
      ) : (
        <ul class="status-list" id="mcp-cli" aria-label="Servers reported by the CLI">
          {cli.length === 0 && <li class="list-empty">The CLI reports no MCP servers.</li>}
          {cli.map((s) => {
            const t = tone(s);
            return (
              <li key={s.name} class="status-item">
                <Icon name={t === "ok" ? "pass-filled" : t === "fail" ? "error" : t === "warn" ? "warning" : "circle-outline"} class={`status-dot ${t}`} />
                <span class="status-name">{s.name}</span>
                <span class="status-detail">{s.status}</span>
                {s.forwarded && (
                  <span class="status-tag" title={needsApproval(s) ? "The extension forwards this server, so it is available in chat" : "The extension also forwards this server"}>
                    Forwarded
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SettingRow>
  );
}

export function McpSection({ settings }: { settings: ExtensionSettings }) {
  const mcp = useSelector((s) => s.mcp);
  useEffect(() => {
    const current = getState().mcp;
    if (!current.status && !current.loading) post({ type: "mcp.status" });
  }, []);
  const checked = mcp.status
    ? new Date(mcp.status.checkedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : undefined;
  return (
    <>
      <SettingsGroup>
        <BoolRow
          settings={settings}
          k="mcpForwardProjectServers"
          label="Forward project servers"
          description="Pass this workspace's .cursor/mcp.json servers to the agent with each session. Without this the CLI silently skips project servers that were never approved in its terminal app. Skipped in untrusted workspaces."
        />
        <TextRow
          settings={settings}
          k="mcpUserConfig"
          label="User-level mcp.json"
          description="The agent loads this file itself, with the sign-ins it saved, so the extension does not forward it. Leave empty to find it from HOME in the agent's environment setting, the running agent's HOME, or your home folder."
          placeholder={mcp.status?.userConfigPath ?? "~/.cursor/mcp.json"}
          mono
        />
        <SettingRow
          id="mcp-open-config"
          labelFor={false}
          label="Project configuration"
          description="This workspace's .cursor/mcp.json, created with an empty server list if it does not exist yet."
          control={
            <button id="mcp-open-config" type="button" class="button secondary small" title="Open .cursor/mcp.json in the editor" onClick={() => post({ type: "mcp.openConfig" })}>
              <Icon name="go-to-file" /> Open mcp.json
            </button>
          }
        />
      </SettingsGroup>
      <PluginsGroup status={mcp.status} loading={mcp.loading} settings={settings} />
      <SettingsGroup
        title="Status"
        actions={
          <>
            {checked && !mcp.loading && <span class="sgroup-note">Checked at {checked}</span>}
            {mcp.loading && (
              <span class="sgroup-note" role="status">
                <Spinner /> Checking…
              </span>
            )}
            <IconButton icon="refresh" label="Refresh status" disabled={mcp.loading} onClick={() => post({ type: "mcp.status" })} />
          </>
        }
      >
        {mcp.status ? (
          <>
            <ForwardedList status={mcp.status} />
            <CliList status={mcp.status} />
          </>
        ) : (
          <div class="srow">
            <div class="list-empty">
              <Spinner /> Asking the CLI which servers it knows…
            </div>
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
