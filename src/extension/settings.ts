/**
 * Bridges VS Code configuration to the in-app settings panel.
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import type { AgentProbe, ExtensionSettings, SettingsKey } from "../shared/protocol";
import { resolveExecutable } from "./acp/resolveExecutable";

const SECTION = "cursorAcp";

type Source = "default" | "user" | "workspace" | "remote";

function sourceOf(inspect: ReturnType<vscode.WorkspaceConfiguration["inspect"]>): Source {
  if (!inspect) return "default";
  if (inspect.workspaceFolderValue !== undefined || inspect.workspaceValue !== undefined) return "workspace";
  // In a remote window, machine-overridable keys stored on the remote surface as globalValue.
  if (inspect.globalValue !== undefined) return vscode.env.remoteName ? "remote" : "user";
  return "default";
}

export function readExtensionSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const keys: SettingsKey[] = ["agentPath", "agentArgs", "environment", "configDir", "resumeLastSession", "sendWithCtrlEnter", "showThoughts", "notifyWhenHidden", "protocolLogging"];
  const sources: Record<string, Source> = {};
  for (const key of keys) sources[key] = sourceOf(config.inspect(key));
  return {
    agentPath: config.get<string>("agentPath", "agent"),
    agentArgs: config.get<string[]>("agentArgs", []),
    environment: config.get<Record<string, string>>("environment", {}),
    configDir: config.get<string>("configDir", ""),
    resumeLastSession: config.get<boolean>("resumeLastSession", true),
    sendWithCtrlEnter: config.get<boolean>("sendWithCtrlEnter", false),
    showThoughts: config.get<boolean>("showThoughts", true),
    notifyWhenHidden: config.get<boolean>("notifyWhenHidden", true),
    protocolLogging: config.get<boolean>("protocolLogging", false),
    sources,
  };
}

/**
 * Writes a setting. Values are stored at the user level (which, in a remote
 * window, is the remote machine's user settings for machine-overridable keys),
 * unless the key is already overridden at workspace level, in which case the
 * workspace value is updated so the change is visible.
 */
export async function updateExtensionSetting(key: SettingsKey, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const inspect = config.inspect(key);
  const target =
    inspect?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

export async function resetExtensionSetting(key: SettingsKey): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  await Promise.all([
    config.update(key, undefined, vscode.ConfigurationTarget.Global),
    config.update(key, undefined, vscode.ConfigurationTarget.Workspace).then(undefined, () => undefined),
  ]);
}

export async function probeAgent(configuredPath: string, env: NodeJS.ProcessEnv): Promise<AgentProbe> {
  const checkedAt = Date.now();
  const resolved = await resolveExecutable(configuredPath || "agent", env);
  if (!resolved) {
    return {
      state: "notFound",
      configuredPath,
      error: `"${configuredPath || "agent"}" was not found.`,
      hint: "Install the Cursor Agent CLI (curl https://cursor.com/install -fsS | bash) or point this at the executable / wrapper script.",
      checkedAt,
    };
  }
  return new Promise<AgentProbe>((resolve) => {
    execFile(resolved, ["--version"], { env, timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          state: "failed",
          configuredPath,
          resolvedPath: resolved,
          error: `Could not run "${resolved} --version": ${error.message}`,
          hint: (stderr || "").trim().slice(0, 300) || "Check that the file is executable and that the wrapper forwards arguments.",
          checkedAt,
        });
        return;
      }
      const version = (stdout || "").trim().split("\n").pop()?.trim();
      resolve({ state: "ok", configuredPath, resolvedPath: resolved, ...(version ? { version } : {}), checkedAt });
    });
  });
}
