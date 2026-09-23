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

let loginShellPathCache: Promise<string | undefined> | undefined;

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

function loginShellPath(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  if (!loginShellPathCache) {
    loginShellPathCache = new Promise((resolve) => {
      const shell = env.SHELL || "/bin/sh";
      const child = execFile(
        shell,
        ["-ilc", 'printf "%s" "$PATH"'],
        { timeout: 5000, env: { ...env, TERM: "dumb" } },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(undefined);
            return;
          }
          // Only keep the last line: some shells print banners in interactive mode.
          const lines = stdout.trim().split("\n");
          resolve(lines[lines.length - 1]?.trim() || undefined);
        },
      );
      child.on("error", () => resolve(undefined));
    });
  }
  return loginShellPathCache;
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
