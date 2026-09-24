/**
 * Cursor `mcp.json` → ACP `mcpServers`.
 *
 * In ACP mode the Cursor CLI only starts a project-level MCP server
 * (`<project>/.cursor/mcp.json`) after it has been approved, and the approval
 * step never reaches an ACP client: an unapproved server just goes missing,
 * with no error. Servers passed in `session/new` / `session/load` are not
 * approval-gated and replace a config-file server of the same name, so the
 * extension reads the config files itself and forwards them.
 *
 * File format (Cursor's): `{ "mcpServers": { "<name>": { command, args?, env?, cwd? } | { url, headers?, type? } } }`,
 * with `${env:VAR}` placeholders resolved from the agent's environment.
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface McpEnvVariable {
  readonly name: string;
  readonly value: string;
}

export interface McpStdioServer {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: ReadonlyArray<McpEnvVariable>;
  /** Cursor accepts a working directory for stdio servers; ACP's schema does not list it, but the CLI reads it. */
  readonly cwd?: string;
}

export interface McpRemoteServer {
  readonly type: "http" | "sse";
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<McpEnvVariable>;
}

export type McpServerSpec = McpStdioServer | McpRemoteServer;

export interface McpConfigSource {
  /** Absolute path of the file. */
  readonly path: string;
  readonly level: "user" | "project";
  /** Names of the servers read from it (empty when the file is missing or invalid). */
  readonly names: ReadonlyArray<string>;
  /** Set when the file exists but could not be used. */
  readonly error?: string;
  readonly missing?: boolean;
}

export interface McpServersResult {
  readonly servers: ReadonlyArray<McpServerSpec>;
  readonly sources: ReadonlyArray<McpConfigSource>;
}

const PLACEHOLDER = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function substitute(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(PLACEHOLDER, (_m, name: string) => env[name] ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, env: NodeJS.ProcessEnv): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => substitute(v, env)) : [];
}

function pairs(value: unknown, env: NodeJS.ProcessEnv): McpEnvVariable[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? [{ name, value: substitute(String(v), env) }] : []));
}

/**
 * Parses one Cursor `mcp.json`. `baseDir` resolves relative commands and
 * working directories (the config's own directory's parent, i.e. the project).
 * Entries that are disabled, malformed, or of an unknown shape are skipped.
 */
export function parseMcpConfig(text: string, options: { env: NodeJS.ProcessEnv; baseDir: string }): { servers: McpServerSpec[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { servers: [], error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const table = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
  if (!table) return { servers: [], error: 'No "mcpServers" object found.' };
  const servers: McpServerSpec[] = [];
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw) || !name.trim()) continue;
    if (raw.disabled === true || raw.enabled === false) continue;
    const { env } = options;
    if (typeof raw.url === "string" && raw.url.trim()) {
      const declared = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
      const type: "http" | "sse" = declared === "sse" ? "sse" : "http";
      servers.push({ type, name, url: substitute(raw.url.trim(), env), headers: pairs(raw.headers, env) });
      continue;
    }
    if (typeof raw.command === "string" && raw.command.trim()) {
      let command = substitute(raw.command.trim(), env);
      // "./server.sh" style commands are relative to the project, not to wherever the CLI happens to run.
      if (/^\.{1,2}[\\/]/.test(command)) command = resolve(options.baseDir, command);
      const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? substitute(raw.cwd.trim(), env) : undefined;
      servers.push({
        name,
        command,
        args: stringList(raw.args, env),
        env: pairs(raw.env, env),
        ...(cwd ? { cwd: isAbsolute(cwd) ? cwd : resolve(options.baseDir, cwd) } : {}),
      });
    }
  }
  return { servers };
}

export interface LoadMcpServersOptions {
  /** Workspace folder; its `.cursor/mcp.json` is the project-level file. Omit to skip project servers. */
  readonly projectDir?: string;
  /** An explicit user-level file to forward as well (the CLI loads its own `~/.cursor/mcp.json` regardless). */
  readonly userConfigPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readText?: (path: string) => Promise<string>;
}

/**
 * Reads the configured files and returns the servers to forward, later files
 * winning on name clashes (project over user), matching how Cursor itself
 * resolves duplicates.
 */
export async function loadMcpServers(options: LoadMcpServersOptions): Promise<McpServersResult> {
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  const files: Array<{ path: string; level: "user" | "project"; baseDir: string }> = [];
  if (options.userConfigPath?.trim()) {
    const path = expandHome(options.userConfigPath.trim(), options.env);
    files.push({ path, level: "user", baseDir: dirname(dirname(path)) });
  }
  if (options.projectDir) files.push({ path: join(options.projectDir, ".cursor", "mcp.json"), level: "project", baseDir: options.projectDir });

  const byName = new Map<string, McpServerSpec>();
  const sources: McpConfigSource[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readText(file.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      sources.push(code === "ENOENT" || code === "ENOTDIR" ? { path: file.path, level: file.level, names: [], missing: true } : { path: file.path, level: file.level, names: [], error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const parsed = parseMcpConfig(text, { env: options.env, baseDir: file.baseDir });
    for (const server of parsed.servers) byName.set(server.name, server);
    sources.push({ path: file.path, level: file.level, names: parsed.servers.map((s) => s.name), ...(parsed.error ? { error: parsed.error } : {}) });
  }
  return { servers: [...byName.values()], sources };
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) {
    const home = env.HOME || env.USERPROFILE || "";
    return home ? join(home, path.slice(1)) : path;
  }
  return path;
}

/** One line per server, for logs and the "Show MCP servers" command. */
export function describeMcpServers(result: McpServersResult): string[] {
  const lines: string[] = [];
  for (const source of result.sources) {
    if (source.missing) continue;
    const label = source.level === "project" ? "project" : "user";
    lines.push(source.error ? `${label} ${source.path}: ${source.error}` : `${label} ${source.path}: ${source.names.length ? source.names.join(", ") : "no servers"}`);
  }
  return lines;
}
