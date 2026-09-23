## Configure the executable

| Setting | Purpose |
| --- | --- |
| `cursorAcp.agentPath` | The `agent` executable or a wrapper script. Resolved from PATH, your login shell, and `~/.local/bin` when not absolute. |
| `cursorAcp.agentArgs` | Extra arguments inserted before `acp` (for example an API endpoint). |
| `cursorAcp.environment` | Extra environment variables for the agent process. |

A wrapper script is a normal shell script that sets up the environment and then runs `exec agent "$@"`. Use one to pick a Cursor account per VS Code profile.

When using Remote SSH the CLI must be installed on the remote machine; these settings are machine-overridable so each host can have its own path.
