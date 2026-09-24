/**
 * Keeps the Cursor plugin MCP servers in the agent's user-level mcp.json
 * (see session/cursorPlugins.ts for why that is where they must go).
 *
 * Which mcp.json: the agent may run with a different HOME than VS Code (a
 * wrapper per account, or HOME in the environment setting), so the Cursor
 * folder is resolved in this order:
 *   1. the `cursorAcp.mcpUserConfig` setting,
 *   2. HOME (Windows: USERPROFILE, then HOME) in the `cursorAcp.environment` setting,
 *   3. the HOME of the running agent process (read by pid after `initialize`),
 *   4. the extension host's home folder.
 * The HOME seen in 3 is remembered per agent command line, so later launches
 * can sync before the agent starts.
 *
 * In "auto" mode every plugin server that is not excluded is added on
 * connect; entries the extension added are remembered per file so turning a
 * server off only ever removes what the extension wrote. No `vscode` import.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { discoverPluginMcpServers, isServerEnabled, readUserMcp, setPluginServers, type PluginDiscovery, type PluginMcpServer } from "./session/cursorPlugins";

export type PluginMode = "auto" | "manual" | "off";
export type UserConfigSource = "settings" | "environment" | "agent" | "default";

export interface ResolvedUserConfig {
  /** Absolute path of the user-level mcp.json. */
  readonly path: string;
  /** Its folder (Cursor's folder, which holds `plugins/`). */
  readonly cursorDir: string;
  readonly source: UserConfigSource;
}

// ---------------------------------------------------------------------------
// HOME of a running process
// ---------------------------------------------------------------------------

/**
 * HOME candidates from `ps -E -ww -o command= -p <pid>` output (macOS): the
 * command line followed by `NAME=value` pairs separated by spaces. Values may
 * contain spaces, so a value runs up to the next ` NAME=` (upper-case name).
 * The environment comes after the arguments, so the last HOME= is the most
 * likely one; candidates are returned last first.
 */
export function homeCandidatesFromPs(output: string): string[] {
  const line = output.replace(/\r?\n+$/, "");
  const starts: number[] = [];
  const pattern = /(?:^|\s)HOME=/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) starts.push(match.index + match[0].length);
  const candidates: string[] = [];
  for (const start of starts.reverse()) {
    const rest = line.slice(start);
    const next = /\s[A-Z_][A-Z0-9_]*=/.exec(rest);
    const value = (next ? rest.slice(0, next.index) : rest).trimEnd();
    if (value) candidates.push(value);
  }
  return candidates;
}

/** HOME from a Linux `/proc/<pid>/environ` buffer (NUL-separated `NAME=value`). */
export function homeFromEnviron(environ: Buffer | string): string | undefined {
  const text = typeof environ === "string" ? environ : environ.toString("utf8");
  for (const entry of text.split("\0")) if (entry.startsWith("HOME=") && entry.length > 5) return entry.slice(5);
  return undefined;
}

export interface DetectDeps {
  readonly platform?: NodeJS.Platform;
  readonly runPs?: (pid: number) => Promise<string>;
  readonly readEnviron?: (pid: number) => Promise<Buffer>;
  readonly isDirectory?: (path: string) => Promise<boolean>;
}

function runPs(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The HOME a running process was started with (macOS and Linux; undefined elsewhere or when it cannot be read). */
export async function detectProcessHome(pid: number | undefined, deps: DetectDeps = {}): Promise<string | undefined> {
  if (!pid) return undefined;
  const platform = deps.platform ?? process.platform;
  const isDir = deps.isDirectory ?? isDirectory;
  try {
    if (platform === "darwin") {
      for (const candidate of homeCandidatesFromPs(await (deps.runPs ?? runPs)(pid))) if (candidate.startsWith("/") && (await isDir(candidate))) return candidate;
      return undefined;
    }
    if (platform === "linux") {
      const home = homeFromEnviron(await (deps.readEnviron ?? ((p: number) => readFile(`/proc/${p}/environ`)))(pid));
      return home && (await isDir(home)) ? home : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Which mcp.json
// ---------------------------------------------------------------------------

/** HOME set explicitly in the environment setting (Windows: USERPROFILE first). */
export function homeFromEnvironmentSetting(environment: Readonly<Record<string, string>>, windows = process.platform === "win32"): string | undefined {
  const keys = windows ? ["USERPROFILE", "HOME"] : ["HOME"];
  for (const key of keys) {
    const value = environment[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export interface ResolveInput {
  readonly setting: string;
  readonly environment: Readonly<Record<string, string>>;
  /** HOME seen on the agent process for this command line, if known. */
  readonly agentHome?: string;
  readonly homedir?: string;
  readonly windows?: boolean;
}

export function resolveUserMcpConfig(input: ResolveInput): ResolvedUserConfig {
  const home = input.homedir ?? osHomedir();
  const inHome = (dir: string, source: UserConfigSource): ResolvedUserConfig => {
    const cursorDir = join(dir, ".cursor");
    return { path: join(cursorDir, "mcp.json"), cursorDir, source };
  };
  const setting = input.setting.trim();
  if (setting) {
    const path = expandHome(setting, home);
    return { path, cursorDir: dirname(path), source: "settings" };
  }
  const envHome = homeFromEnvironmentSetting(input.environment, input.windows);
  if (envHome) return inHome(expandHome(envHome, home), "environment");
  if (input.agentHome) return inHome(input.agentHome, "agent");
  return inHome(home, "default");
}

/** Only an explicitly configured file may be anything but `…/.cursor/mcp.json`. */
export function safeToSync(config: ResolvedUserConfig): boolean {
  if (config.source === "settings") return true;
  return config.path.endsWith(`${sep}.cursor${sep}mcp.json`) || config.path.endsWith("/.cursor/mcp.json");
}

// ---------------------------------------------------------------------------
// What to change
// ---------------------------------------------------------------------------

export interface SyncPlan {
  readonly add: ReadonlyArray<PluginMcpServer>;
  readonly remove: ReadonlyArray<string>;
  /** Ids the extension will have added once the plan is applied. */
  readonly managed: ReadonlyArray<string>;
}

export interface PlanInput {
  readonly discovery: Pick<PluginDiscovery, "servers" | "complete">;
  readonly current: Readonly<Record<string, unknown>>;
  readonly exclude: ReadonlyArray<string>;
  readonly managed: ReadonlyArray<string>;
}

/** Cursor's own naming for plugin servers; mcp.json entries with it belong to plugins, the rest are the user's custom servers. */
export function isPluginServerId(id: string): boolean {
  return id.startsWith("plugin-");
}

/**
 * Auto mode: add every plugin server that is not excluded and not already in
 * the file; remove plugin entries that are now excluded or whose plugin was
 * uninstalled. Plugin entries are the `plugin-…` ones (Cursor's naming);
 * custom servers such as GitHub are never touched.
 */
export function planPluginSync(input: PlanInput): SyncPlan {
  const exclude = new Set(input.exclude);
  const managed = new Set([...input.managed, ...Object.keys(input.current).filter(isPluginServerId)].filter((id) => Object.prototype.hasOwnProperty.call(input.current, id)));
  const discovered = new Set(input.discovery.servers.map((s) => s.id));
  const add: PluginMcpServer[] = [];
  const remove: string[] = [];
  for (const server of input.discovery.servers) {
    if (exclude.has(server.id)) continue;
    if (isServerEnabled(input.current, server)) continue;
    add.push(server);
    managed.add(server.id);
  }
  for (const id of [...managed]) {
    const gone = input.discovery.complete && !discovered.has(id);
    if (exclude.has(id) || gone) {
      remove.push(id);
      managed.delete(id);
    }
  }
  return { add, remove, managed: [...managed].sort() };
}

// ---------------------------------------------------------------------------
// The orchestrator used by the extension
// ---------------------------------------------------------------------------

export interface PluginSyncSettings {
  readonly mode: PluginMode;
  readonly exclude: ReadonlyArray<string>;
  readonly userConfig: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): void | Thenable<void>;
}

export interface PluginSyncDeps {
  readonly settings: () => PluginSyncSettings;
  /** Persists the exclude list (the `cursorAcp.mcpPluginExclude` setting). */
  readonly setExclude: (ids: ReadonlyArray<string>) => Promise<void>;
  /** The extension's global state. */
  readonly store: KeyValueStore;
  readonly log: { info(message: string): void; warn(message: string): void };
  readonly detectHome?: (pid: number | undefined) => Promise<string | undefined>;
  readonly homedir?: () => string;
  readonly windows?: boolean;
}

export interface LaunchIdentity {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface SyncOutcome {
  readonly changed: boolean;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly error?: string;
}

const HOMES_KEY = "cursorAcp.agentHomes";
const MANAGED_KEY = "cursorAcp.pluginMcpManaged";
const UNCHANGED: SyncOutcome = { changed: false, added: [], removed: [] };

export function launchKey(launch: LaunchIdentity): string {
  return JSON.stringify([launch.command, ...launch.args]);
}

export class PluginMcpSync {
  private readonly homes = new Map<string, string>();
  private lastLaunch: LaunchIdentity | undefined;
  /** The file changed after the running agent read it (cleared when the agent restarts). */
  reconnectNeeded = false;

  constructor(private readonly deps: PluginSyncDeps) {
    for (const [key, home] of Object.entries(deps.store.get<Record<string, string>>(HOMES_KEY) ?? {})) this.homes.set(key, home);
  }

  /** The mcp.json in use for this command line (the last launched one when omitted). */
  resolve(launch: LaunchIdentity | undefined = this.lastLaunch): ResolvedUserConfig {
    const settings = this.deps.settings();
    const agentHome = launch ? this.homes.get(launchKey(launch)) : undefined;
    return resolveUserMcpConfig({
      setting: settings.userConfig,
      environment: settings.environment,
      ...(agentHome ? { agentHome } : {}),
      ...(this.deps.homedir ? { homedir: this.deps.homedir() } : {}),
      ...(this.deps.windows !== undefined ? { windows: this.deps.windows } : {}),
    });
  }

  managedIds(path: string): string[] {
    return [...(this.deps.store.get<Record<string, string[]>>(MANAGED_KEY)?.[path] ?? [])];
  }

  private async setManaged(path: string, ids: ReadonlyArray<string>): Promise<void> {
    const all = { ...(this.deps.store.get<Record<string, string[]>>(MANAGED_KEY) ?? {}) };
    if (ids.length) all[path] = [...ids];
    else delete all[path];
    await this.deps.store.update(MANAGED_KEY, all);
  }

  /** Before spawning: sync when the file is already known (setting, environment setting or a remembered HOME). */
  async beforeSpawn(launch: LaunchIdentity): Promise<void> {
    this.lastLaunch = launch;
    this.reconnectNeeded = false;
    if (this.deps.settings().mode !== "auto") return;
    const config = this.resolve(launch);
    if (config.source === "default") return;
    await this.syncLogged(config);
  }

  /**
   * After `initialize`: learn the agent's HOME and sync if that points at a
   * different file than before. Returns true when the file changed, so the
   * caller restarts the agent once to load it.
   */
  async afterInitialize(launch: LaunchIdentity, pid: number | undefined): Promise<boolean> {
    this.lastLaunch = launch;
    const settings = this.deps.settings();
    const before = this.resolve(launch);
    if (before.source === "settings" || before.source === "environment") return false;
    const key = launchKey(launch);
    const detected = await (this.deps.detectHome ?? ((p) => detectProcessHome(p)))(pid);
    if (!detected) {
      // Not readable (Windows, or ps failed): the remembered or default file; a no-op when beforeSpawn already synced it.
      return settings.mode === "auto" ? (await this.syncLogged(before)).changed : false;
    }
    if (this.homes.get(key) === detected) return false;
    this.homes.set(key, detected);
    const stored = { ...(this.deps.store.get<Record<string, string>>(HOMES_KEY) ?? {}), [key]: detected };
    await this.deps.store.update(HOMES_KEY, stored);
    this.deps.log.info(`Agent HOME read from the agent process: ${detected}`);
    if (settings.mode !== "auto") return false;
    return (await this.syncLogged(this.resolve(launch))).changed;
  }

  private async syncLogged(config: ResolvedUserConfig): Promise<SyncOutcome> {
    const outcome = await this.sync(config);
    if (outcome.error) this.deps.log.warn(`Cursor plugin MCP servers: ${outcome.error}`);
    if (outcome.added.length) this.deps.log.info(`Added Cursor plugin MCP servers to ${config.path}: ${outcome.added.join(", ")}`);
    if (outcome.removed.length) this.deps.log.info(`Removed Cursor plugin MCP servers from ${config.path}: ${outcome.removed.join(", ")}`);
    return outcome;
  }

  /** Applies auto mode to one file. */
  async sync(config: ResolvedUserConfig = this.resolve()): Promise<SyncOutcome> {
    if (!safeToSync(config)) return { ...UNCHANGED, error: `not syncing ${config.path}: it is not a .cursor/mcp.json file` };
    const discovery = discoverPluginMcpServers(config.cursorDir);
    try {
      const current = readUserMcp(config.path);
      if (!current.exists && discovery.servers.length === 0) return UNCHANGED;
      const plan = planPluginSync({ discovery, current: current.servers, exclude: this.deps.settings().exclude, managed: this.managedIds(config.path) });
      const result = setPluginServers(config.path, plan.add, plan.remove);
      const managed = plan.managed.filter((id) => !plan.add.some((s) => s.id === id) || result.added.includes(id));
      await this.setManaged(config.path, managed);
      return result;
    } catch (error) {
      return { ...UNCHANGED, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The per-server switch. Auto mode: off adds the ids to the exclude list and
   * removes their plugin entries; on takes them off the list and syncs. Manual mode: writes or removes the entries directly.
   */
  async setEnabled(ids: ReadonlyArray<string>, enabled: boolean, launch?: LaunchIdentity): Promise<SyncOutcome> {
    const settings = this.deps.settings();
    const config = this.resolve(launch ?? this.lastLaunch);
    if (settings.mode === "off") return UNCHANGED;
    let outcome: SyncOutcome;
    if (settings.mode === "auto") {
      const exclude = new Set(settings.exclude);
      for (const id of ids) {
        if (enabled) exclude.delete(id);
        else exclude.add(id);
      }
      await this.deps.setExclude([...exclude].sort());
      outcome = await this.sync(config);
    } else {
      const discovery = discoverPluginMcpServers(config.cursorDir);
      const wanted = discovery.servers.filter((s) => ids.includes(s.id));
      const result = setPluginServers(config.path, enabled ? wanted : [], enabled ? [] : [...ids]);
      const managed = new Set(this.managedIds(config.path));
      for (const id of result.added) managed.add(id);
      for (const id of result.removed) managed.delete(id);
      await this.setManaged(config.path, [...managed].sort());
      outcome = result;
    }
    if (outcome.error) throw new Error(outcome.error);
    if (outcome.changed) this.reconnectNeeded = true;
    return outcome;
  }
}
