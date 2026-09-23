# Cursor Agent for VS Code

A native-feeling chat sidebar for the **Cursor Agent CLI**, built on Cursor's
[Agent Client Protocol](https://cursor.com/docs/cli/acp) mode (`agent acp`).
It focuses on the folder you have open and stays out of the way: no worktree
management, no separate server, just the agent running on the machine that
hosts your workspace.

## Features

- Streaming chat with grouped assistant messages, collapsible thoughts, tool
  cards with live command output, and inline diffs that open in VS Code's
  diff editor.
- Explicit permission prompts (Allow / Always allow / Reject). Nothing is
  auto-approved.
- Cursor's Agent / Ask / Plan modes, model picker with per-model options
  (effort, context size, fast mode), slash commands, questions
  (`cursor/ask_question`), plan proposals (`cursor/create_plan`) and todo
  updates (`cursor/update_todos`).
- Session history and resume. Replayed history is rendered as history, never
  as fresh streaming output.
- Stop/cancel that really cancels (`session/cancel`, with pending permission
  requests answered as cancelled), clear connection errors, and a reconnect
  flow when the agent process exits.
- Works with local folders and Remote SSH: the extension runs on the workspace
  extension host, so the agent launches where the code lives.
- Keyboard-friendly UI that follows your VS Code theme.

## Setup

1. Install the Cursor Agent CLI and log in (`agent login`).
2. Open the **Cursor Agent** view in the activity bar (or `Cmd+Alt+C`). By
   default the extension looks for `cursor-agent`, then `agent`, on your
   PATH, your login shell's PATH, and `~/.local/bin` (the specific name is
   tried first because other CLIs also install a bare `agent`). A configured
   path is always used instead. If nothing is found, a setup card asks for the path. Use the gear in the view for the in-app settings panel (path with
   Browse and Test, extra args, environment, behaviour), or VS Code's settings
   editor; both write the same `cursorAcp.*` settings.
3. A wrapper script works as the path too, e.g.
   `/Users/me/.local/bin/cursor-flexnet`, which selects the account and
   config directory before exec'ing the real CLI. The extension always runs
   `<agentPath> [agentArgs...] acp`.
4. The **Get started** walkthrough (Help → Welcome) covers the same steps.

### Settings

| Setting | Description |
| --- | --- |
| `cursorAcp.agentPath` | Executable (or wrapper) that supports `acp`. Empty auto-detects `cursor-agent`, then `agent`; a configured value is always used instead. Machine-overridable, so remotes can differ. |
| `cursorAcp.agentArgs` | Extra arguments inserted before `acp` (e.g. `-e <endpoint>`). |
| `cursorAcp.environment` | Extra environment variables for the agent process. |
| `cursorAcp.resumeLastSession` | Resume the last session for the folder when the view opens. |
| `cursorAcp.sendWithCtrlEnter` | Send with Ctrl/Cmd+Enter instead of Enter. |
| `cursorAcp.showThoughts` | Show thinking blocks. |
| `cursorAcp.notifyWhenHidden` | OS-style notifications for permissions / finished turns when the view is hidden. |
| `cursorAcp.protocolLogging` | Log every JSON-RPC message to the *Cursor Agent* output channel. |

### Commands & keys

| Command | Default key |
| --- | --- |
| Cursor Agent: Open Cursor | `Cmd+Alt+C` / `Ctrl+Alt+C` |
| Cursor Agent: Add Selection to Cursor | `Cmd+Alt+A` / `Ctrl+Alt+A` |
| Cursor Agent: New Session | `Cmd+Alt+N` (when the chat is focused) |
| Cursor Agent: Session History… | |
| Cursor Agent: Open Cursor in Editor | |
| Cursor Agent: Stop Current Turn / Reconnect Agent / Show Logs | |

In the chat: `Enter` sends, `Shift+Enter` inserts a newline, `Esc` stops the
current turn, `/` opens the command list, `@` mentions a workspace file, `↑`
on an empty box recalls the previous prompt. When a permission prompt is showing, `Enter`/`y` allows,
`a` always allows, `n`/`Esc` rejects.

## How it works

```
VS Code window ── webview (Preact UI) ── postMessage ── extension host
                                                          │
                                        SessionRuntime ── ThreadModel
                                                          │
                                         AcpConnection (JSON-RPC over stdio)
                                                          │
                                              `agent acp` child process
```

- `src/extension/acp/*`: process supervision, newline-delimited JSON-RPC,
  typed ACP methods and Cursor extension methods.
- `src/extension/session/ThreadModel.ts`: turns `session/update` notifications
  into the transcript (grouping, tool-call merging, diffs, replay flags).
- `src/extension/session/SessionRuntime.ts`: session lifecycle, prompts,
  cancellation, permissions, questions, plans, modes/models, reconnect.
- `src/webview/*`: the UI.

The implementation follows the behaviour of T3 Code's Cursor integration
(`apps/server/src/provider/acp` and `Layers/CursorAdapter.ts`): initialize →
authenticate (`cursor_login`) → `session/new` or `session/load`, history
replayed before the load response, `session/set_config_option` for mode and
model, `cursor/list_available_models` for per-model options, and pending
permissions answered with `cancelled` on cancel.

## Development

```
npm install
npm run build          # bundles extension + webview into dist/
npm run typecheck
npm test               # unit + fake-agent runtime tests
CURSOR_ACP_E2E=1 npm run test:e2e   # real agent (uses Cursor usage)
npm run package        # writes build/cursor-agent-<version>.vsix (or ./build.sh)
```

Press F5 in VS Code to launch an Extension Development Host.

### Packaging and installing

`npm run package` runs the esbuild bundle (extension host code to
`dist/extension.js`, webview to `dist/webview/`), then `vsce package` zips
`package.json`, `dist/`, `media/`, `README.md`, `CHANGELOG.md` and `LICENSE`
into a `.vsix` under the gitignored `build/` directory. `.vscodeignore`
keeps sources, tests and maps out of the archive, and `--no-dependencies`
skips `node_modules` because everything is bundled.

`./build.sh` wraps the same steps (`--check` runs typecheck and tests first,
`--install` installs the result with the `code` CLI).

The VSIX is profile-agnostic. Which VS Code profile it goes into is decided
when you install it, either from the Extensions view (`…` menu → **Install
from VSIX…**, into the current profile) or with the CLI:

```
code --install-extension build/cursor-agent-0.1.0.vsix
```

Add `--profile <name>` to that command to target a different profile.
