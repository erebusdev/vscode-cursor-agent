/**
 * Decides how to launch a resolved agent executable.
 *
 * On macOS/Linux (and therefore WSL and Remote SSH) the resolved path is run
 * directly. On native Windows the Cursor installer ships no `.exe`, only
 * `agent.cmd` / `agent.ps1` shims that end up running
 * `versions\<latest>\node.exe index.js`. Node cannot spawn `.cmd` files
 * without a shell, and going through `cmd.exe` → `powershell.exe` → `node.exe`
 * adds two process layers that a plain kill would orphan. So when the shim
 * layout is recognised we launch `node.exe index.js` ourselves, mirroring what
 * the shim does; any other `.cmd`/`.bat`/`.ps1` still goes through the
 * matching interpreter.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface LaunchPlan {
  /** Program to spawn. */
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  /** Extra environment the shim would have set. */
  readonly env?: Readonly<Record<string, string>>;
  /** Pass args through untouched (needed for the `cmd.exe /c "..."` form). */
  readonly windowsVerbatimArguments?: boolean;
  /** How the launch was decided; shown in logs and errors. */
  readonly mode: "direct" | "cursor-shim" | "cmd" | "powershell";
}

/** Version directory names the Cursor shim accepts: 2026.09.23-abc123 or 2026.09.23-10-11-12-abc123. */
const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

function versionKey(name: string): number {
  const m = VERSION_DIR.exec(name);
  if (!m) return -1;
  return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]);
}

export interface CursorShimTarget {
  readonly node: string;
  readonly index: string;
  readonly version: string;
}

/**
 * Given a Cursor `agent.cmd`/`agent.ps1`/`cursor-agent.*` shim, finds the
 * `node.exe` + `index.js` pair it would run. Returns undefined for anything
 * that is not laid out like a Cursor CLI install.
 */
export function findCursorShimTarget(shimPath: string): CursorShimTarget | undefined {
  const dir = dirname(shimPath);
  // The shim can also live inside a version directory next to node.exe.
  if (existsSync(join(dir, "node.exe")) && existsSync(join(dir, "index.js"))) {
    return { node: join(dir, "node.exe"), index: join(dir, "index.js"), version: basename(dir) };
  }
  const versions = join(dir, "versions");
  let names: string[];
  try {
    names = readdirSync(versions, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VERSION_DIR.test(d.name))
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  names.sort((a, b) => versionKey(b) - versionKey(a) || b.localeCompare(a));
  for (const name of names) {
    const node = join(versions, name, "node.exe");
    const index = join(versions, name, "index.js");
    if (existsSync(node) && existsSync(index)) return { node, index, version: name };
  }
  return undefined;
}

/** Quote one argument for `cmd.exe /c`. */
function cmdQuote(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) || arg === "" ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export function planLaunch(resolvedPath: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): LaunchPlan {
  if (platform !== "win32") return { file: resolvedPath, args, mode: "direct" };
  const lower = resolvedPath.toLowerCase();
  const isScript = /\.(cmd|bat|ps1)$/.test(lower);
  if (!isScript) return { file: resolvedPath, args, mode: "direct" };

  const target = findCursorShimTarget(resolvedPath);
  if (target) {
    const extra: Record<string, string> = { CURSOR_INVOKED_AS: basename(resolvedPath) };
    // The shim enables Node's compile cache for faster startup; do the same.
    if (!env.NODE_COMPILE_CACHE && env.LOCALAPPDATA) extra.NODE_COMPILE_CACHE = join(env.LOCALAPPDATA, "cursor-compile-cache");
    return { file: target.node, args: [target.index, ...args], env: extra, mode: "cursor-shim" };
  }
  if (lower.endsWith(".ps1")) {
    const powershell = join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { file: powershell, args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolvedPath, ...args], mode: "powershell" };
  }
  const comspec = env.ComSpec || join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const line = [resolvedPath, ...args].map(cmdQuote).join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, mode: "cmd" };
}
