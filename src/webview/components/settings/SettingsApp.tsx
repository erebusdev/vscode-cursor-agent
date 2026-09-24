/**
 * The settings editor tab: a section list down the left, the section's
 * cards on the right. Loaded from the same bundle as the chat, in the
 * webview the host marks with `data-view="settings"`.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ExtensionSettings } from "../../../shared/protocol";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../../shared/settingsUi";
import { setSettingsSection, useSelector } from "../../store";
import { post } from "../../vscode";
import { Toasts } from "../Toasts";
import { Icon, Spinner } from "../ui";
import { SettingRow, SettingsGroup } from "./controls";
import { ManageModels } from "./ManageModels";
import { McpSection } from "./McpSection";
import { AgentArgsRow, AgentPathRow, ApprovalPolicyRow, BoolRow, EnvRow, ModelDefaultsRow, SafeListEditor, SendShortcutRow, TextRow } from "./rows";

const SECTION_INFO: Record<SettingsSection, { label: string; icon: string; hint: string }> = {
  general: { label: "General", icon: "settings", hint: "Sessions, sending, thinking blocks and notifications" },
  agent: { label: "Agent", icon: "terminal", hint: "Where the Cursor Agent CLI is and how it is started" },
  approvals: { label: "Approvals", icon: "shield", hint: "What runs without asking" },
  models: { label: "Models", icon: "sparkle", hint: "Defaults for new sessions and which models the picker shows" },
  mcp: { label: "MCP servers", icon: "plug", hint: "Which MCP servers the agent gets and what the CLI reports" },
  advanced: { label: "Advanced", icon: "tools", hint: "Logging, VS Code's settings editor and version" },
};

/** Tracks a media query (the nav turns into a row of icons on narrow tabs). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    onChange();
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function Nav({ current }: { current: SettingsSection }) {
  const horizontal = useMediaQuery("(max-width: 480px)");
  const refs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const go = (section: SettingsSection, focus: boolean) => {
    setSettingsSection(section);
    if (focus) refs.current[section]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const i = SETTINGS_SECTIONS.indexOf(current);
    const n = SETTINGS_SECTIONS.length;
    let next: number | undefined;
    // Vertical list at normal widths, a row of icons when narrow: accept both axes.
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i + n - 1) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === undefined) return;
    e.preventDefault();
    go(SETTINGS_SECTIONS[next]!, true);
  };
  return (
    <nav class="settings-nav" aria-label="Settings sections">
      <div class="settings-nav-list" role="tablist" aria-orientation={horizontal ? "horizontal" : "vertical"} aria-label="Settings sections" onKeyDown={onKeyDown}>
        {SETTINGS_SECTIONS.map((id) => {
          const info = SECTION_INFO[id];
          const selected = id === current;
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[id] = el;
              }}
              id={`settings-nav-${id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="settings-page"
              tabIndex={selected ? 0 : -1}
              class={`settings-nav-item${selected ? " selected" : ""}`}
              title={`${info.label}: ${info.hint}`}
              onClick={() => go(id, false)}
            >
              <Icon name={info.icon} />
              <span class="settings-nav-label">{info.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function GeneralPage({ settings }: { settings: ExtensionSettings }) {
  return (
    <>
      <SettingsGroup>
        <BoolRow settings={settings} k="resumeLastSession" label="Resume last session" description="Reopen this workspace's last session when the chat starts." />
        <BoolRow settings={settings} k="notifyWhenHidden" label="Notify when hidden" description="Show a VS Code notification when the agent needs permission or finishes while the chat is not visible." />
        <BoolRow settings={settings} k="editorTitleButton" label="Editor title button" description="Show an Open Cursor button in the editor title bar." />
      </SettingsGroup>
      <SettingsGroup title="Chat">
        <SendShortcutRow settings={settings} />
        <BoolRow settings={settings} k="showThoughts" label="Show thinking" description="Show the agent's reasoning blocks in the transcript." />
      </SettingsGroup>
    </>
  );
}

function AgentPage({ settings }: { settings: ExtensionSettings }) {
  const [changed, setChanged] = useState(false);
  const mark = () => setChanged(true);
  return (
    <>
      <SettingsGroup>
        <AgentPathRow settings={settings} onSaved={mark} />
        <AgentArgsRow settings={settings} onSaved={mark} />
      </SettingsGroup>
      <SettingsGroup title="Environment">
        <EnvRow settings={settings} onSaved={mark} />
      </SettingsGroup>
      <SettingsGroup title="Usage">
        <TextRow settings={settings} k="configDir" label="Config directory" description="Cursor's config directory, holding auth.json. Only the usage panel reads it; leave empty to detect it from CURSOR_CONFIG_DIR, a wrapper script or ~/.cursor." placeholder="~/.cursor" mono />
      </SettingsGroup>
      {changed && (
        <div class="settings-footer" role="status">
          <Icon name="info" />
          <span>Changes to the agent path, arguments or environment take effect on the next connection.</span>
          <button title="Restart the agent with the new settings" type="button" class="button secondary small" onClick={() => post({ type: "session.reconnect" })}>
            <Icon name="refresh" /> Reconnect now
          </button>
        </div>
      )}
    </>
  );
}

function ApprovalsPage({ settings }: { settings: ExtensionSettings }) {
  return (
    <>
      <SettingsGroup>
        <ApprovalPolicyRow settings={settings} />
      </SettingsGroup>
      <SettingsGroup title="Safe list">
        <SafeListEditor settings={settings} />
      </SettingsGroup>
    </>
  );
}

function ModelsPage({ settings }: { settings: ExtensionSettings }) {
  return (
    <>
      <SettingsGroup>
        <ModelDefaultsRow settings={settings} />
      </SettingsGroup>
      <SettingsGroup title="Visible models">
        <ManageModels />
      </SettingsGroup>
    </>
  );
}

function AdvancedPage({ settings }: { settings: ExtensionSettings }) {
  const version = document.body.dataset.version;
  return (
    <>
      <SettingsGroup>
        <BoolRow settings={settings} k="protocolLogging" label="Protocol logging" description="Log every ACP JSON-RPC message to the Cursor Agent output channel. Useful when reporting a problem; noisy otherwise." />
        <SettingRow
          id="advanced-logs"
          label="Logs"
          description="The Cursor Agent output channel: connection, probe and MCP messages."
          control={
            <button id="advanced-logs" type="button" class="button secondary small" title="Open the Cursor Agent output channel" onClick={() => post({ type: "openLogs" })}>
              <Icon name="output" /> Show logs
            </button>
          }
        />
        <SettingRow
          id="advanced-vscode-settings"
          label="VS Code settings"
          description="Every cursorAcp.* setting in VS Code's settings editor, including workspace overrides."
          control={
            <button id="advanced-vscode-settings" type="button" class="button secondary small" title="Open VS Code's settings editor filtered to this extension" onClick={() => post({ type: "openSettings" })}>
              <Icon name="link-external" /> Open in VS Code settings editor
            </button>
          }
        />
        {version && <SettingRow id="advanced-version" label="Version" description="Cursor Agent (VSCode ACP) extension." control={<span class="srow-value" id="advanced-version">{version}</span>} />}
      </SettingsGroup>
    </>
  );
}

function Page({ section, settings }: { section: SettingsSection; settings: ExtensionSettings }) {
  switch (section) {
    case "general":
      return <GeneralPage settings={settings} />;
    case "agent":
      return <AgentPage settings={settings} />;
    case "approvals":
      return <ApprovalsPage settings={settings} />;
    case "models":
      return <ModelsPage settings={settings} />;
    case "mcp":
      return <McpSection settings={settings} />;
    case "advanced":
      return <AdvancedPage settings={settings} />;
  }
}

function Scroll({ section, children }: { section: SettingsSection; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  // A new section starts at the top.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [section]);
  return (
    <main ref={ref} class="settings-main" id="settings-page" role="tabpanel" aria-labelledby={`settings-nav-${section}`} tabIndex={-1}>
      {children}
    </main>
  );
}

export function SettingsApp() {
  const settings = useSelector((s) => s.extSettings);
  const section = useSelector((s) => s.settingsSection);
  useEffect(() => {
    post({ type: "settings.get" });
    post({ type: "settings.probe" });
  }, []);
  return (
    <div class="settings-app">
      <Nav current={section} />
      <Scroll section={section}>
        <div class="settings-content">
          <h1 class="settings-page-title">{SECTION_INFO[section].label}</h1>
          {!settings ? (
            <div class="list-empty" role="status">
              <Spinner /> Loading settings…
            </div>
          ) : (
            <Page key={section} section={section} settings={settings} />
          )}
        </div>
      </Scroll>
      <Toasts />
    </div>
  );
}
