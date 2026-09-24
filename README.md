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
path, set it in the view's settings (gear icon). The extension runs
`<agentPath> [agentArgs...] acp`.

## Settings

| Setting | Description |
| --- | --- |
| `cursorAcp.agentPath` | Executable or wrapper script. Empty = auto-detect. Used by macOS, Linux, WSL and Remote SSH hosts. |
| `cursorAcp.agentPathWindows` | Same, but read only when VS Code itself runs on Windows. Empty = auto-detect. |
| `cursorAcp.agentArgs` | Extra args inserted before `acp`. |
| `cursorAcp.environment` | Extra env vars for the agent process. |
| `cursorAcp.configDir` | Cursor config dir, used by the usage panel. Empty = auto-detect. |
| `cursorAcp.resumeLastSession` | Resume the folder's last session on open. |
| `cursorAcp.sendWithCtrlEnter` | Send with Ctrl/Cmd+Enter instead of Enter. |
| `cursorAcp.showThoughts` | Show thinking blocks. |
| `cursorAcp.notifyWhenHidden` | Notify on permission requests and finished turns while the view is hidden. |
| `cursorAcp.editorTitleButton` | Show the Open Cursor button in the editor title bar. |
| `cursorAcp.protocolLogging` | Log every JSON-RPC message to the output channel. |

## Keys

| Key | Action |
| --- | --- |
| `Cmd+Alt+C` | Open Cursor |
| `Cmd+Alt+A` | Add selection to Cursor |
| `Cmd+Alt+N` | New session (while the view is focused) |
| `Enter` / `Shift+Enter` | Send / insert newline |
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

> [!NOTE]
> No support provided, no contributions accepted. If something doesn't work
> or you would like changes, [fork it on GitHub](https://github.com/erebusdev/vscode-cursor-agent)
> and modify it for your own use.
