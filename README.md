# Cursor Agent for VS Code

A VS Code extension that runs the [Cursor Agent CLI](https://cursor.com/docs/cli)
in the sidebar. It talks to the CLI over its Agent Client Protocol mode
(`agent acp`) and gives you streaming chat, tool calls, diffs, permission
prompts, mode and model selection, and session resume. Works on macOS, Linux
and Windows, and inside WSL and Remote SSH windows.

## Install

Download the `.vsix` from Releases, then:

```
code --install-extension cursor-agent-<version>.vsix
```

## Setup

Open the Cursor view with `Cmd+Alt+C` (`Ctrl+Alt+C` on Windows and Linux).
If the CLI is missing or not logged in, the view offers to install it and
sign you in; both run Cursor's own commands in a visible terminal on the
machine that hosts your workspace, so WSL and remote windows set up the
remote side.

The extension finds `cursor-agent` or `agent` on your PATH, or in Cursor's
default install location. If you use a wrapper script or a non-standard
path, set it on the Agent page of the settings tab (gear icon in the chat
header). The extension runs `<agentPath> [agentArgs...] acp`.

## Settings

Settings open in their own editor tab, *Cursor Agent Settings*: click the
gear in the chat header, or run *Cursor Agent: Open Settings* from the
Command Palette. Pages down the left: General, Agent, Approvals, Models,
MCP servers and Advanced. *Manage models…* in the model picker opens the
Models page, and the setup card's *All settings* opens the Agent page.
Changes are saved as you make them, to your user settings (or to the
workspace settings when the value is already set there); a badge next to a
setting shows where its value comes from, with a Reset link.

Every setting is also a regular VS Code setting under `cursorAcp.*`
(*Advanced → Open in VS Code settings editor*):

| Setting | Description |
| --- | --- |
| `cursorAcp.agentPath` | Executable or wrapper script. Empty = auto-detect. Used by macOS, Linux, WSL and Remote SSH hosts. |
| `cursorAcp.agentPathWindows` | Same, but read only when VS Code itself runs on Windows. Empty = auto-detect. |
| `cursorAcp.agentArgs` | Extra args inserted before `acp`. |
| `cursorAcp.environment` | Extra env vars for the agent process. |
| `cursorAcp.configDir` | Cursor config dir, used by the usage panel. Empty = auto-detect. |
| `cursorAcp.mcpForwardProjectServers` | Pass the workspace's `.cursor/mcp.json` servers to the agent with each session (default on; skipped in untrusted workspaces). In ACP mode the CLI otherwise skips project servers that were never approved in its terminal app, without saying so. |
| `cursorAcp.mcpUserConfig` | The user-level `mcp.json` this profile's agent reads, shown on the MCP servers page. Not forwarded: the agent loads it itself, with its saved sign-ins. |
| `cursorAcp.resumeLastSession` | Resume the folder's last session on open. |
| `cursorAcp.sendWithCtrlEnter` | Send with Ctrl/Cmd+Enter instead of Enter. |
| `cursorAcp.showThoughts` | Show thinking blocks. |
| `cursorAcp.notifyWhenHidden` | Notify on permission requests and finished turns while the view is hidden. |
| `cursorAcp.approvalPolicy` | Default approvals for new sessions: `ask`, `safe` (read-only commands and tools run without asking) or `auto`. Switchable per session from the toolbar. |
| `cursorAcp.safeList` | Regexes for the safe list, tested against each part of a shell command and against Cursor's tool pattern such as `Mcp(server:tool)`. |
| `cursorAcp.hiddenModels` | Model ids hidden from the picker. New models stay visible until hidden. Managed from *Manage models…* in the picker. |
| `cursorAcp.defaultModel` | Model for new sessions. Empty = the CLI's current default. *Set as default* in the picker writes it. |
| `cursorAcp.defaultModelOptions` | Option values (effort, context, fast…) for new sessions, e.g. `{ "effort": "high" }`. |
| `cursorAcp.editorTitleButton` | Show the Open Cursor button in the editor title bar. |
| `cursorAcp.protocolLogging` | Log every JSON-RPC message to the output channel. |

## MCP servers

The agent reads MCP servers from Cursor's `~/.cursor/mcp.json` (for the account it runs as) and the workspace's `.cursor/mcp.json`. Project servers need an approval that only Cursor's terminal app can give, so the extension forwards them itself; user-level ones load as they do in the CLI. The *MCP servers* page of the settings tab lists what is forwarded and what the CLI reports (*Cursor Agent: Show MCP Servers* writes the same to the output channel), and opens the project's `.cursor/mcp.json`, creating it if needed. Read-only MCP tools (names starting with get, list, search, read…) run without asking under the Safe list policy; the rest prompt, with *Allow for session* available.

Cursor plugins (Atlassian, Sentry, Figma…) bring MCP servers that only Cursor's terminal app loads; ACP sessions do not. To use one in chat, add it to the user-level `mcp.json` under the plugin's name, e.g. `"plugin-sentry-sentry": { "url": "https://mcp.sentry.dev/mcp" }`. The agent then reuses the sign-in Cursor saved for that plugin in the project; if it shows *requires_authentication*, run `agent mcp login plugin-sentry-sentry` in the project folder once.

The agent is started with your login shell's PATH, so servers launched with `npx`, `node` or `uvx` resolve even when VS Code was opened from the Dock.

## Keys

| Key | Action |
| --- | --- |
| `Cmd+Alt+C` | Open Cursor |
| `Cmd+Alt+A` | Add selection to Cursor |
| `Cmd+Alt+N` | New session (while the view is focused) |
| `Cmd+Alt+Y` | Cycle approvals: Ask → Safe list → Auto (while the view is focused) |
| Palette: *Cursor Agent: Copy Session Id* | Copies the current Cursor session id (also on each history row) |
| Palette: *Cursor Agent: Open Settings* | Opens the settings tab (also the gear in the chat header) |
| `↑` `↓` `Home` `End` | Move between settings pages when the page list has focus |
| `Enter` / `Shift+Enter` | Send / insert newline (swap to `Cmd+Enter` under *General → Send shortcut*) |
| `Esc` | Stop the current turn |
| `/` `@` `↑` | Commands, file mentions, previous prompt |
| `y` `a` `n` | Allow, always allow, reject a permission prompt |

Use `Ctrl` in place of `Cmd` on Windows and Linux.

## Development

```
npm install
npm run build        # or: npm run watch
npm test
npm run package      # writes build/cursor-agent-<version>.vsix
./build.sh --check   # typecheck + test + package; add --install to install it
```

`F5` launches an Extension Development Host. `CURSOR_ACP_E2E=1 npm run test:e2e`
runs the tests against the real CLI and consumes Cursor usage.

---

**Note:** No support provided, no contributions accepted. If something doesn't
work or you would like changes, [fork it on GitHub](https://github.com/erebusdev/vscode-cursor-agent)
and modify it for your own use.
