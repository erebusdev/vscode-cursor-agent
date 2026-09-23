/**
 * Resolves the configured agent executable to an absolute path.
 *
 * VS Code's extension host (especially when launched from the Dock on macOS)
 * often has a minimal PATH, so a bare `agent` may not resolve. We try, in
 * order: an explicit path, PATH lookup, the user's login shell PATH, and a
 * few well-known install locations.
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Login-shell PATH probes, keyed by the shell + PATH they were run with. */
const loginShellPathCache = new Map<string, { promise: Promise<string | undefined> }>();
/** A successful probe is valid for the process lifetime; a failed one is retried after this. */
const FAILED_PROBE_TTL_MS = 30_000;
const LOGIN_SHELL_TIMEOUT_MS = 5000;
const PATH_MARKER = "__CURSOR_ACP_PATH__";
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Test hook: forget cached login-shell PATH probes. */
export function resetLoginShellPathCache(): void {
  loginShellPathCache.clear();
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function findInPath(name: string, pathValue: string | undefined): Promise<string | undefined> {
  if (!pathValue) return undefined;
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function probeLoginShellPath(shell: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      // Interactive login shells may print banners / MOTD / prompt fragments to stdout, so the
      // PATH is wrapped in markers and extracted rather than assumed to be the whole output.
      ["-ilc", `printf "\\n${PATH_MARKER}%s${PATH_MARKER}\\n" "$PATH"`],
      { timeout: LOGIN_SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...env, TERM: "dumb" } },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(undefined);
          return;
        }
        const clean = stdout.replace(ANSI_PATTERN, "");
        // The last marker pair wins (a shell with `set -v` may echo the command itself first).
        const end = clean.lastIndexOf(PATH_MARKER);
        const first = end > 0 ? clean.lastIndexOf(PATH_MARKER, end - 1) : -1;
        if (first < 0) {
          resolve(undefined);
          return;
        }
        const value = clean.slice(first + PATH_MARKER.length, end).trim();
        resolve(value || undefined);
      },
    );
    child.on("error", () => resolve(undefined));
  });
}

function loginShellPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  const shell = env.SHELL || "/bin/sh";
  const key = `${shell}\u0000${env.PATH ?? ""}`;
  const cached = loginShellPathCache.get(key);
  if (cached) return cached.promise;
  const entry = { promise: probeLoginShellPath(shell, env) };
  loginShellPathCache.set(key, entry);
  void entry.promise.then((value) => {
    if (value === undefined) {
      // Do not pin a failure (slow shell, transient error) for the whole process lifetime.
      setTimeout(() => {
        if (loginShellPathCache.get(key) === entry) loginShellPathCache.delete(key);
      }, FAILED_PROBE_TTL_MS).unref?.();
    }
  });
  return entry.promise;
}

export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const trimmed = expandHome(command.trim());
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    return (await isExecutable(trimmed)) ? trimmed : undefined;
  }
  const fromPath = await findInPath(trimmed, env.PATH);
  if (fromPath) return fromPath;
  const fromLoginShell = await findInPath(trimmed, await loginShellPath(env));
  if (fromLoginShell) return fromLoginShell;
  const home = homedir();
  const wellKnown = [
    join(home, ".local", "bin", trimmed),
    join(home, ".cursor", "bin", trimmed),
    "/usr/local/bin/" + trimmed,
    "/opt/homebrew/bin/" + trimmed,
  ];
  for (const candidate of wellKnown) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}
