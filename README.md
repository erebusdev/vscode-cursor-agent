# Cursor Agent for VS Code

The [Cursor Agent CLI](https://cursor.com/docs/cli) in a VS Code sidebar, via
its ACP mode (`agent acp`). Streaming chat, tool calls, diffs, permission
prompts, modes and models, session resume. Works locally and over Remote SSH.

Personal project. Not on the Marketplace, no support.

## Install

Download the `.vsix` from Releases, then:

```
code --install-extension cursor-agent-<version>.vsix
```

## Setup

1. Install the CLI and log in: `curl https://cursor.com/install -fsS | bash`, then `agent login`.
2. Open the Cursor view (`Cmd+Alt+C`). The extension finds `cursor-agent` or
   `agent` on your PATH. If it doesn't, or you use a wrapper script, set the
   path in the view's settings (gear icon) or `cursorAcp.agentPath`.

The extension runs `<agentPath> [agentArgs...] acp`.

## Settings

| Setting | |
| --- | --- |
| `cursorAcp.agentPath` | Executable or wrapper script. Empty = auto-detect. |
| `cursorAcp.agentArgs` | Extra args inserted before `acp`. |
| `cursorAcp.environment` | Extra env vars for the agent process. |
| `cursorAcp.configDir` | Cursor config dir, for the usage panel. Empty = auto-detect. |
| `cursorAcp.resumeLastSession` | Resume the folder's last session on open. |
| `cursorAcp.sendWithCtrlEnter` | Send with Ctrl/Cmd+Enter instead of Enter. |
| `cursorAcp.showThoughts` | Show thinking blocks. |
| `cursorAcp.notifyWhenHidden` | Notify on permission requests and finished turns when the view is hidden. |
| `cursorAcp.editorTitleButton` | Show the Open Cursor button in the editor title bar. |
| `cursorAcp.protocolLogging` | Log every JSON-RPC message to the output channel. |

## Keys

| | |
| --- | --- |
| `Cmd+Alt+C` | Open Cursor |
| `Cmd+Alt+A` | Add selection to Cursor |
| `Cmd+Alt+N` | New session (view focused) |
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Stop the current turn |
| `/` `@` `↑` | Commands, file mentions, previous prompt |
| `y` `a` `n` | Allow, always allow, reject a permission prompt |

Use `Ctrl` instead of `Cmd` on Windows and Linux.

## Development

```
npm install
npm run build        # or: npm run watch
npm test
npm run package      # build/cursor-agent-<version>.vsix
./build.sh --check   # typecheck + test + package; --install also installs it
```

`F5` launches an Extension Development Host. `CURSOR_ACP_E2E=1 npm run test:e2e`
runs against the real CLI and uses Cursor usage.
