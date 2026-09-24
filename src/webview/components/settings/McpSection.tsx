import { useEffect } from "preact/hooks";
import type { ExtensionSettings, McpCliServer, McpStatus } from "../../../shared/protocol";
import { mcpNeedsApproval as needsApproval } from "../../../shared/settingsUi";
import { getState, useSelector } from "../../store";
import { post } from "../../vscode";
import { Icon, IconButton, Spinner } from "../ui";
import { SettingRow, SettingsGroup } from "./controls";
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

function ForwardedList({ status }: { status: McpStatus }) {
  const broken = status.files.filter((f) => f.state === "error");
  return (
    <SettingRow
      id="mcp-forwarded"
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
  const checked = mcp.status ? new Date(mcp.status.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined;
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
          description="Also forward the servers in this file. Leave empty when the CLI already loads yours; set it when the agent runs as a different account than the one holding your config."
          placeholder="~/.cursor/mcp.json"
          mono
        />
        <SettingRow
          id="mcp-open-config"
          label="Project configuration"
          description="This workspace's .cursor/mcp.json, created with an empty server list if it does not exist yet."
          control={
            <button id="mcp-open-config" type="button" class="button secondary small" title="Open .cursor/mcp.json in the editor" onClick={() => post({ type: "mcp.openConfig" })}>
              <Icon name="go-to-file" /> Open mcp.json
            </button>
          }
        />
      </SettingsGroup>
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
            <IconButton icon="refresh" label="Check again (reads the mcp.json files and runs agent mcp list)" disabled={mcp.loading} onClick={() => post({ type: "mcp.status" })} />
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
