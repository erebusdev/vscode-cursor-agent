/**
 * Which `cursorAcp.*` key holds the agent path for this extension host.
 *
 * A native Windows host reads `agentPathWindows`; every other host (macOS,
 * Linux, WSL, Remote SSH) reads `agentPath`. Keeping them separate means a
 * Windows path in the user's settings never leaks into a WSL window, where
 * machine-overridable settings inherit from the local user settings unless
 * explicitly overridden.
 */
export type AgentPathKey = "agentPath" | "agentPathWindows";

export const AGENT_PATH_KEY: AgentPathKey = process.platform === "win32" ? "agentPathWindows" : "agentPath";

export const IS_WINDOWS = process.platform === "win32";
