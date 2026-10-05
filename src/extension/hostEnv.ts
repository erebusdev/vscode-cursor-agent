/**
 * Environment for everything the extension spawns (agent, probes, `mcp list`):
 * the extension host's environment with the login shell's PATH in front and
 * the user's `cursorAcp.environment` on top.
 *
 * VS Code opened from the Dock or a desktop shortcut gets a minimal PATH, so
 * the agent, and the stdio MCP servers it starts with `npx`, `node`, `uvx`…,
 * cannot find tools the terminal finds. The host process itself is left
 * untouched; other extensions share it.
 */
import { delimiter } from "node:path";
import { loginShellPath } from "./acp/resolveExecutable";

let loginPath: string | undefined;
let prepared: Promise<void> | undefined;

/** Resolves the login-shell PATH once (bounded by the resolver's 5 s timeout); safe to await from several places. */
export function prepareHostEnv(log?: { info(message: string): void }): Promise<void> {
  if (!prepared) {
    prepared = loginShellPath(process.env).then(
      (path) => {
        loginPath = path;
        if (path) log?.info(`Login shell PATH: ${path}`);
        else if (process.platform !== "win32") log?.info("Login shell PATH unavailable; using the extension host's PATH.");
      },
      () => undefined,
    );
  }
  return prepared;
}

export function hostEnv(extra?: Readonly<Record<string, unknown>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const merged = mergePath(loginPath, process.env.PATH);
  if (merged) env.PATH = merged;
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Login-shell entries first, then whatever the host already had, without duplicates. */
export function mergePath(loginPath: string | undefined, hostPath: string | undefined, separator: string = delimiter): string | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const source of [loginPath, hostPath]) {
    for (const entry of (source ?? "").split(separator)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return merged.length ? merged.join(separator) : undefined;
}

/** Test hook. */
export function _setLoginPathForTests(path: string | undefined): void {
  loginPath = path;
  prepared = Promise.resolve();
}
