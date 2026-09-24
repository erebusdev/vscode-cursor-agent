/**
 * Cursor plugin MCP servers.
 *
 * Cursor's terminal app loads the MCP servers that come with installed Cursor
 * plugins (Atlassian, Sentry, Figma…); ACP mode does not. It does load the
 * user-level mcp.json, and an entry there under the plugin's own server id
 * (`plugin-<plugin>-<server>`) reuses the sign-in Cursor saved for the
 * plugin. This module finds the plugin servers on disk and adds or removes
 * those entries, leaving everything else in the file alone.
 *
 * No `vscode` import: unit tested against fixture folders.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type PluginTransport = "http" | "sse" | "stdio";

export interface PluginMcpServer {
  /** The name Cursor gives the server: `plugin-<pluginName>-<serverName>`. */
  readonly id: string;
  readonly pluginName: string;
  readonly serverName: string;
  readonly transport: PluginTransport;
  readonly url?: string;
  readonly command?: string;
  /** The object written into mcp.json (placeholders expanded, headers kept). */
  readonly entry: Readonly<Record<string, unknown>>;
}

export interface PluginDiscovery {
  readonly pluginsDir: string;
  readonly servers: ReadonlyArray<PluginMcpServer>;
  /** Unreadable manifests, plugin.json or MCP files; discovery carries on past them. */
  readonly errors: ReadonlyArray<string>;
  /** Whether the list of installed plugins could be read (so a missing server really was uninstalled). */
  readonly complete: boolean;
}

export const MANIFEST_FILE = ".cloud-plugin-manifest.json";

export function pluginServerId(pluginName: string, serverName: string): string {
  return `plugin-${pluginName}-${serverName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text.replace(/^﻿/, ""));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Replaces `${CURSOR_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` in every string of a JSON value. */
function expandPlaceholders(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replace(/\$\{(?:CURSOR|CLAUDE)_PLUGIN_ROOT\}/g, root);
  if (Array.isArray(value)) return value.map((v) => expandPlaceholders(v, root));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandPlaceholders(v, root)]));
  return value;
}

interface PluginRoot {
  readonly name: string;
  readonly root: string;
}

/** Live plugins from the cloud manifest; folders named after plugins next to them are stale copies. */
function cachedPlugins(pluginsDir: string, errors: string[]): { plugins: PluginRoot[]; complete: boolean } {
  const cacheDir = join(pluginsDir, "cache");
  const manifestPath = join(cacheDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { plugins: [], complete: existsSync(pluginsDir) };
  let manifest: unknown;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    errors.push(`${manifestPath}: ${describe(error)}`);
    return { plugins: [], complete: false };
  }
  const list = isRecord(manifest) && Array.isArray(manifest.plugins) ? manifest.plugins : undefined;
  if (!list) {
    errors.push(`${manifestPath}: no "plugins" list`);
    return { plugins: [], complete: false };
  }
  const plugins: PluginRoot[] = [];
  let complete = true;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name : undefined;
    const pluginId = typeof entry.pluginId === "string" || typeof entry.pluginId === "number" ? String(entry.pluginId) : undefined;
    const slug = typeof entry.marketplaceSlug === "string" ? entry.marketplaceSlug : undefined;
    const version = typeof entry.resolvedCommitSha === "string" && entry.resolvedCommitSha ? entry.resolvedCommitSha : typeof entry.gitRef === "string" ? entry.gitRef : undefined;
    if (!name || !pluginId || !slug || !version) {
      errors.push(`${manifestPath}: skipped an entry without name, pluginId, marketplaceSlug or version`);
      continue;
    }
    const root = join(cacheDir, slug, pluginId, version);
    if (!existsSync(root)) {
      // Listed but not downloaded yet: its servers are unknown, so do not treat them as removed.
      errors.push(`${name}: not downloaded yet (${root})`);
      complete = false;
      continue;
    }
    plugins.push({ name, root });
  }
  return { plugins, complete };
}

/** Locally installed plugins: each subfolder with a `.cursor-plugin/plugin.json`. */
function localPlugins(pluginsDir: string, errors: string[]): PluginRoot[] {
  const localDir = join(pluginsDir, "local");
  let names: string[];
  try {
    names = readdirSync(localDir);
  } catch {
    return [];
  }
  const plugins: PluginRoot[] = [];
  for (const folder of names.sort()) {
    const root = join(localDir, folder);
    const manifest = join(root, ".cursor-plugin", "plugin.json");
    if (!existsSync(manifest)) continue;
    let name = folder;
    try {
      const parsed = readJson(manifest);
      if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name.trim()) name = parsed.name.trim();
    } catch (error) {
      errors.push(`${manifest}: ${describe(error)}`);
    }
    plugins.push({ name, root });
  }
  return plugins;
}

/** The `mcpServers` map of one plugin, from plugin.json (path or inline) or `.mcp.json` / `mcp.json`. */
function pluginServerMap(plugin: PluginRoot, errors: string[]): Record<string, unknown> | undefined {
  const manifestPath = join(plugin.root, ".cursor-plugin", "plugin.json");
  let pointer: unknown;
  if (existsSync(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      if (isRecord(manifest)) pointer = manifest.mcpServers ?? manifest.mcp;
    } catch (error) {
      errors.push(`${plugin.name}: ${manifestPath}: ${describe(error)}`);
    }
  }
  const unwrap = (value: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(value)) return undefined;
    if (isRecord(value.mcpServers)) return value.mcpServers;
    return value;
  };
  if (isRecord(pointer)) return unwrap(pointer);
  let file: string | undefined;
  if (typeof pointer === "string" && pointer.trim()) {
    file = resolve(plugin.root, pointer.trim());
    if (!existsSync(file)) {
      errors.push(`${plugin.name}: MCP file ${pointer} not found`);
      return undefined;
    }
  } else {
    file = [".mcp.json", "mcp.json"].map((f) => join(plugin.root, f)).find((f) => existsSync(f));
  }
  if (!file) return undefined;
  try {
    const parsed = unwrap(readJson(file));
    if (!parsed) errors.push(`${plugin.name}: ${file}: not an object`);
    return parsed;
  } catch (error) {
    errors.push(`${plugin.name}: ${file}: ${describe(error)}`);
    return undefined;
  }
}

function toServer(plugin: PluginRoot, serverName: string, raw: unknown, errors: string[]): PluginMcpServer | undefined {
  if (!isRecord(raw)) {
    errors.push(`${plugin.name}: server "${serverName}" is not an object`);
    return undefined;
  }
  const entry = expandPlaceholders(raw, plugin.root) as Record<string, unknown>;
  const id = pluginServerId(plugin.name, serverName);
  const base = { id, pluginName: plugin.name, serverName, entry };
  if (typeof entry.url === "string" && entry.url) {
    return { ...base, transport: entry.type === "sse" ? "sse" : "http", url: entry.url };
  }
  if (typeof entry.command === "string" && entry.command) {
    return { ...base, transport: "stdio", command: entry.command };
  }
  errors.push(`${plugin.name}: server "${serverName}" has neither a url nor a command`);
  return undefined;
}

/**
 * Every MCP server of the plugins installed under `<cursorDir>/plugins`,
 * sorted by plugin, then server. Never throws.
 */
export function discoverPluginMcpServers(cursorDir: string): PluginDiscovery {
  const pluginsDir = join(cursorDir, "plugins");
  const errors: string[] = [];
  const cached = cachedPlugins(pluginsDir, errors);
  const plugins = [...cached.plugins, ...localPlugins(pluginsDir, errors)];
  const servers: PluginMcpServer[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const map = pluginServerMap(plugin, errors);
    if (!map) continue;
    for (const [serverName, raw] of Object.entries(map)) {
      const server = toServer(plugin, serverName, raw, errors);
      if (!server || seen.has(server.id)) continue;
      seen.add(server.id);
      servers.push(server);
    }
  }
  servers.sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.serverName.localeCompare(b.serverName));
  return { pluginsDir, servers, errors, complete: cached.complete };
}

// ---------------------------------------------------------------------------
// The user-level mcp.json
// ---------------------------------------------------------------------------

export interface UserMcp {
  readonly exists: boolean;
  /** The whole file (other top-level keys are written back untouched). */
  readonly data: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
}

export class UserMcpError extends Error {}

/** Reads the user-level mcp.json; a missing file is empty, an invalid one throws a UserMcpError. */
export function readUserMcp(path: string): UserMcp {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, data: {}, servers: {} };
    throw new UserMcpError(`Could not read ${path}: ${describe(error)}`);
  }
  if (!text.trim()) return { exists: true, data: {}, servers: {} };
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new UserMcpError(`${path} is not valid JSON, so it was left unchanged (${describe(error)}). Fix or remove it, then try again.`);
  }
  if (!isRecord(data)) throw new UserMcpError(`${path} does not contain a JSON object, so it was left unchanged.`);
  if (data.mcpServers !== undefined && !isRecord(data.mcpServers)) throw new UserMcpError(`"mcpServers" in ${path} is not an object, so the file was left unchanged.`);
  return { exists: true, data, servers: isRecord(data.mcpServers) ? data.mcpServers : {} };
}

/** URL for comparison: no trailing slash on the path, query kept, scheme and host lower-cased. */
export function normaliseUrl(url: string): string {
  const trimmed = url.trim();
  const cut = trimmed.search(/[?#]/);
  const base = (cut < 0 ? trimmed : trimmed.slice(0, cut)).replace(/\/+$/, "");
  const rest = cut < 0 ? "" : trimmed.slice(cut);
  const lowered = base.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i, (m) => m.toLowerCase());
  return lowered + rest;
}

/** Whether the file already provides this server: under its id, or any entry with the same URL. */
export function isServerEnabled(servers: Readonly<Record<string, unknown>>, server: Pick<PluginMcpServer, "id" | "url">): boolean {
  if (Object.prototype.hasOwnProperty.call(servers, server.id)) return true;
  if (!server.url) return false;
  const wanted = normaliseUrl(server.url);
  return Object.values(servers).some((entry) => isRecord(entry) && typeof entry.url === "string" && normaliseUrl(entry.url) === wanted);
}

/** Writes via a temp file in the same folder and a rename, keeping the file's mode (0600 for a new file). */
function writeAtomic(path: string, text: string): void {
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    // New file.
  }
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

export interface SetPluginServersResult {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly changed: boolean;
}

/**
 * Adds plugin servers that the file does not provide yet and removes the given
 * ids; every other key and entry is kept as it was. Writes only when
 * something changed. Throws a UserMcpError when the file is not valid JSON.
 */
export function setPluginServers(path: string, add: ReadonlyArray<Pick<PluginMcpServer, "id" | "url" | "entry">>, remove: ReadonlyArray<string>): SetPluginServersResult {
  if (!isAbsolute(path)) throw new UserMcpError(`The mcp.json path must be absolute: ${path}`);
  const current = readUserMcp(path);
  const servers: Record<string, unknown> = { ...current.servers };
  const removed: string[] = [];
  for (const id of remove) {
    if (Object.prototype.hasOwnProperty.call(servers, id)) {
      delete servers[id];
      removed.push(id);
    }
  }
  const added: string[] = [];
  for (const server of add) {
    if (remove.includes(server.id) || isServerEnabled(servers, server)) continue;
    servers[server.id] = server.entry;
    added.push(server.id);
  }
  if (added.length === 0 && removed.length === 0) return { added, removed, changed: false };
  const data = { ...current.data, mcpServers: servers };
  if (!existsSync(dirname(path))) throw new UserMcpError(`The folder for ${path} does not exist.`);
  writeAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  return { added, removed, changed: true };
}
