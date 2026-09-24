import { useEffect, useState } from "preact/hooks";
import type { ExtensionSettings, McpCliServer, McpPluginServer, McpPluginSkills, McpStatus } from "../../../shared/protocol";
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

const MODE_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    hint: "Add all plugin servers except those switched off",
  },
  {
    value: "manual",
    label: "Manual",
    hint: "Add only the servers switched on",
  },
  { value: "off", label: "Off", hint: "Don't add plugin servers" },
] as const;

type PluginMode = (typeof MODE_OPTIONS)[number]["value"];

const MODE_DESC: Record<PluginMode, string> = {
  auto: "All plugin servers are added, except those switched off.",
  manual: "Only the servers switched on below are added.",
  off: "Plugin servers are not added.",
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
      title: "Not available in chat",
    };
  if (needsSignIn(server))
    return {
      text: "Needs sign-in",
      tone: "warn",
      title: `Agent status: ${status}`,
    };
  if (status && /error|fail|crash|unreachable/i.test(status))
    return {
      text: "Error",
      tone: "fail",
      title: `Agent status: ${status}`,
    };
  if (status && /ready|connected|running|ok\b/i.test(status))
    return {
      text: "Ready",
      tone: "ok",
      title: `Agent status: ${status}`,
    };
  if (status)
    return {
      text: status,
      tone: "muted",
      title: `Agent status: ${status}`,
    };
  return {
    text: "Added",
    tone: "muted",
    title: reconnectNeeded ? "Reconnect to load it" : "Not reported by the agent yet",
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
  const toggleTitle =
    mode === "off"
      ? "Plugin servers are off"
      : on
          ? "Available in chat"
          : "Not available in chat";
  return (
    <SettingRow
      class="plugin-row"
      id={id}
      label={label}
      description={
        <span title={server.id}>
          <span class="plugin-transport">{TRANSPORT_LABEL[server.transport]}</span> · {server.host}
        </span>
      }
      control={
        <>
          <span class={`plugin-chip ${chip.tone}`} title={chip.title}>
            <Icon name={CHIP_ICON[chip.tone]} class={`status-dot ${chip.tone}`} />
            {chip.text}
          </span>
          {needsSignIn(server) && server.enabled && (
            <button type="button" class="button secondary small" title="Sign in to this server" onClick={() => post({ type: "mcp.plugins.login", id: server.id })}>
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
      description="MCP servers that come with your Cursor plugins."
      actions={
        <>
          {mode !== "off" && off.length > 0 && plugins.length > 0 && (
            <button
              type="button"
              class="button secondary small"
              title="Turn on all plugin servers"
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
          <IconButton icon="go-to-file" label="Open mcp.json" disabled={!path} onClick={() => post({ type: "mcp.openUserConfig" })} />
        </>
      }
    >
      {status?.reconnectNeeded && (
        <div class="srow plugin-banner" role="status">
          <Icon name="info" />
          <span class="plugin-banner-text">Plugins changed. Reconnect to apply.</span>
          <button type="button" class="button primary small" title="Restart the agent" onClick={() => post({ type: "session.reconnect" })}>
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
          <div class="list-empty">No Cursor plugins with MCP servers found.</div>
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

// ---------------------------------------------------------------------------
// Plugin skills
// ---------------------------------------------------------------------------

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function skillsSummary(row: McpPluginSkills): string {
  const parts = [];
  if (row.skills.length) parts.push(plural(row.skills.length, "skill"));
  if (row.commands.length) parts.push(plural(row.commands.length, "command"));
  return parts.join(" · ");
}

function skillsChip(row: McpPluginSkills, on: boolean, reconnectNeeded: boolean): Chip {
  if (!on) return { text: "Not in chat", tone: "muted", title: "Not available in chat" };
  if (row.clashes.length)
    return {
      text: row.clashes.length === 1 ? "1 skipped" : `${row.clashes.length} skipped`,
      tone: "warn",
      title: `You already have a skill with this name: ${row.clashes.map((n) => `/${n}`).join(", ")}`,
    };
  const total = row.skills.length + row.commands.length;
  if (row.linked.length >= total) return { text: "In chat", tone: "ok", title: "Available in chat" };
  return { text: "Added", tone: "muted", title: reconnectNeeded ? "Reconnect to load them" : "Added on the next connect" };
}

function SkillsRow({ row, on, disabled, reconnectNeeded, onToggle }: { row: McpPluginSkills; on: boolean; disabled: boolean; reconnectNeeded: boolean; onToggle: (next: boolean) => void }) {
  const chip = skillsChip(row, on && !disabled, reconnectNeeded);
  const id = `plugin-skills-${row.pluginName}`;
  const names = [...row.skills, ...row.commands].map((n) => `/${n}`).join("\n");
  return (
    <SettingRow
      class="plugin-row"
      id={id}
      label={titleCase(row.pluginName)}
      description={<span title={names}>{skillsSummary(row)}</span>}
      control={
        <>
          <span class={`plugin-chip ${chip.tone}`} title={chip.title}>
            <Icon name={CHIP_ICON[chip.tone]} class={`status-dot ${chip.tone}`} />
            {chip.text}
          </span>
          <Toggle id={id} checked={on} disabled={disabled} title={disabled ? "Plugin skills are off" : on ? "Available in chat" : "Not available in chat"} onChange={onToggle} />
        </>
      }
    />
  );
}

function SkillsGroup({ status, loading, settings }: { status: McpStatus | undefined; loading: boolean; settings: ExtensionSettings }) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  useEffect(() => setPending({}), [status]);
  const enabled = settings.pluginSkills ?? status?.pluginSkillsOn ?? true;
  const rows = status?.pluginSkills ?? [];
  const isOn = (r: McpPluginSkills) => pending[r.pluginName] ?? !r.excluded;
  const off = rows.filter((r) => !isOn(r));
  const set = (plugins: string[], next: boolean) => {
    setPending((prev) => ({ ...prev, ...Object.fromEntries(plugins.map((p) => [p, next])) }));
    post({ type: "plugins.skills.set", plugins, enabled: next });
  };
  return (
    <SettingsGroup
      title="Plugin skills"
      id="plugin-skills"
      description="Skills and commands that come with your Cursor plugins."
      actions={
        enabled && off.length > 0 ? (
          <button type="button" class="button secondary small" title="Turn on all plugin skills" disabled={loading} onClick={() => set(off.map((r) => r.pluginName), true)}>
            Enable all
          </button>
        ) : undefined
      }
    >
      <SettingRow
        id="plugin-skills-on"
        label="Use plugin skills"
        description="Adds them to the / menu in chat."
        control={<Toggle id="plugin-skills-on" checked={enabled} title={enabled ? "Plugin skills are on" : "Plugin skills are off"} onChange={(next) => updateSetting("pluginSkills", next)} />}
      />
      {!status ? (
        <div class="srow">
          <div class="list-empty">
            <Spinner /> Looking for plugin skills…
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div class="srow">
          <div class="list-empty">No Cursor plugins with skills found.</div>
        </div>
      ) : (
        rows.map((r) => <SkillsRow key={r.pluginName} row={r} on={isOn(r)} disabled={!enabled} reconnectNeeded={!!status.reconnectNeeded} onToggle={(next) => set([r.pluginName], next)} />)
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
      label="Forwarded servers"
      description={
        status.projectSkipped
          ? `Project servers not forwarded: ${status.projectSkipped}.`
          : "Sent to the agent with every session."
      }
    >
      <ul class="status-list" id="mcp-forwarded" aria-label="Forwarded servers">
        {status.forwarded.length === 0 && <li class="list-empty">None.</li>}
        {status.forwarded.map((s) => (
          <li key={s.name} class="status-item">
            <Icon name="pass-filled" class="status-dot ok" />
            <span class="status-name">{s.name}</span>
            <span class="status-tag" title={s.source === "project" ? "From this workspace" : "From your MCP config file"}>
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
      label="Reported by the agent"
      description="Every MCP server the agent knows about."
    >
      {"error" in cli ? (
        <div class="probe-status fail" role="alert" id="mcp-cli">
          <Icon name="error" />
          <span>{cli.error}</span>
        </div>
      ) : (
        <ul class="status-list" id="mcp-cli" aria-label="Servers reported by the agent">
          {cli.length === 0 && <li class="list-empty">No MCP servers.</li>}
          {cli.map((s) => {
            const t = tone(s);
            return (
              <li key={s.name} class="status-item">
                <Icon name={t === "ok" ? "pass-filled" : t === "fail" ? "error" : t === "warn" ? "warning" : "circle-outline"} class={`status-dot ${t}`} />
                <span class="status-name">{s.name}</span>
                <span class="status-detail">{s.status}</span>
                {s.forwarded && (
                  <span class="status-tag" title={needsApproval(s) ? "Available in chat" : "Also sent with every session"}>
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
          label="Project MCP servers"
          description="Use this workspace's MCP servers in chat."
        />
        <TextRow
          settings={settings}
          k="mcpUserConfig"
          label="MCP config file"
          description="Leave empty to use the default."
          placeholder={mcp.status?.userConfigPath ?? "~/.cursor/mcp.json"}
          mono
        />
        <SettingRow
          id="mcp-open-config"
          labelFor={false}
          label="Project config file"
          control={
            <button id="mcp-open-config" type="button" class="button secondary small" title="Open mcp.json" onClick={() => post({ type: "mcp.openConfig" })}>
              <Icon name="go-to-file" /> Open mcp.json
            </button>
          }
        />
      </SettingsGroup>
      <PluginsGroup status={mcp.status} loading={mcp.loading} settings={settings} />
      <SkillsGroup status={mcp.status} loading={mcp.loading} settings={settings} />
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
            <IconButton icon="refresh" label="Refresh" disabled={mcp.loading} onClick={() => post({ type: "mcp.status" })} />
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
              <Spinner /> Checking MCP servers…
            </div>
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
