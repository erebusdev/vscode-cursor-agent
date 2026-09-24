/**
 * MCP status: which servers the extension forwards to the agent (read from
 * the mcp.json files, see mcpConfig.ts) and what the CLI itself reports via
 * `agent mcp list`. Used by the settings tab's MCP section and by the
 * *Show MCP Servers* command. No `vscode` import, so it is unit-testable.
 */
import { execFile } from "node:child_process";
import type { McpCliServer, McpConfigFileStatus, McpForwardedServer, McpStatus } from "../shared/protocol";
import type { McpServersResult } from "./session/mcpConfig";
import { resolveAgentExecutable } from "./acp/resolveExecutable";
import { planLaunch } from "./acp/windowsLaunch";
import { mcpNeedsApproval as needsApproval } from "../shared/settingsUi";

/** Where a URL points, without path or query (either may carry a token). */
function urlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

/**
 * The forwarded servers with the file each came from. Files are read user
 * first, project second, and a later file wins a name clash, so the last
 * source listing a name is the one in effect. Args and env are left out: after
 * `${env:VAR}` substitution they may contain secrets.
 */
export function forwardedServers(result: McpServersResult): McpForwardedServer[] {
  return result.servers.map((server) => {
    let source: "project" | "user" = "project";
    for (const file of result.sources) if (file.names.includes(server.name)) source = file.level;
    return "url" in server
      ? { name: server.name, source, transport: server.type, target: urlOrigin(server.url) }
      : { name: server.name, source, transport: "stdio" as const, target: server.command };
  });
}

export function configFiles(result: McpServersResult): McpConfigFileStatus[] {
  return result.sources.map((file) => ({
    path: file.path,
    level: file.level,
    state: file.missing ? "missing" : file.error ? "error" : "ok",
    ...(file.error ? { detail: file.error } : {}),
    count: file.names.length,
  }));
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Parses `agent mcp list` output: one `name: status` line per server.
 * Colour codes, bullets and lines without a status (headings, "No MCP
 * servers configured") are ignored.
 */
export function parseMcpList(output: string, forwardedNames: ReadonlyArray<string> = []): McpCliServer[] {
  const forwarded = new Set(forwardedNames);
  const out: McpCliServer[] = [];
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]\s+)?([^:\s][^:]*?)\s*:\s*(.+?)\s*$/.exec(raw);
    if (!match) continue;
    const name = match[1]!;
    const status = match[2]!;
    // A URL ("see https://…") or a diagnostic ("Warning: …") is not a server line.
    if (/^\/\//.test(status) || /^(warning|warn|error|note|info|hint|debug)$/i.test(name)) continue;
    out.push({ name, status, forwarded: forwarded.has(name) });
  }
  return out;
}


export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface McpStatusOptions {
  /** The same loader the sessions use (setting-aware; see extension.ts). */
  readonly loadServers: () => Promise<McpServersResult>;
  readonly launch: { readonly command: string; readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv };
  readonly cwd: string;
  readonly projectSkipped?: string;
  /** Test seams. */
  readonly resolve?: (command: string, env: NodeJS.ProcessEnv) => Promise<{ path: string } | undefined>;
  readonly run?: (file: string, args: ReadonlyArray<string>, options: { cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean }) => Promise<RunResult>;
  readonly now?: () => number;
}

const MCP_LIST_TIMEOUT_MS = 30_000;

function runFile(file: string, args: ReadonlyArray<string>, options: { cwd: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, [...args], { ...options, timeout: MCP_LIST_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(error ? { error } : {}) });
    });
    // A wrapper that waits on stdin must not hang the check.
    child.stdin?.end();
  });
}

export async function collectMcpStatus(options: McpStatusOptions): Promise<McpStatus> {
  const now = options.now ?? Date.now;
  const result = await options.loadServers();
  const forwarded = forwardedServers(result);
  const base = {
    forwarded,
    files: configFiles(result),
    ...(options.projectSkipped ? { projectSkipped: options.projectSkipped } : {}),
  };
  const found = await (options.resolve ?? resolveAgentExecutable)(options.launch.command, options.launch.env);
  if (!found) return { ...base, checkedAt: now(), cli: { error: "The agent executable was not found, so the CLI could not be asked." } };
  const plan = planLaunch(found.path, [...options.launch.args, "mcp", "list"], options.launch.env);
  const env = plan.env ? { ...options.launch.env, ...plan.env } : options.launch.env;
  const run = options.run ?? runFile;
  const { stdout, stderr, error } = await run(plan.file, plan.args, { cwd: options.cwd, env, windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false });
  if (error && !stdout.trim()) {
    const detail = stderr.replace(ANSI, "").trim();
    return { ...base, checkedAt: now(), cliCommand: found.path, cli: { error: `Could not run "${found.path} mcp list": ${error.message}${detail ? `\n${detail}` : ""}` } };
  }
  return { ...base, checkedAt: now(), cliCommand: found.path, cli: parseMcpList(stdout.trim() ? stdout : stderr, forwarded.map((s) => s.name)) };
}

/** Plain-text form for the output channel (the *Show MCP Servers* command). */
export function formatMcpStatus(status: McpStatus): string[] {
  const lines: string[] = ["MCP servers", "Forwarded to the agent by the extension:"];
  if (status.forwarded.length === 0) lines.push(`  (none: ${status.projectSkipped ?? "no mcp.json found"})`);
  for (const s of status.forwarded) lines.push(`  ${s.name} (${s.source}, ${s.transport}: ${s.target})`);
  for (const f of status.files) if (f.state === "error") lines.push(`  ${f.level} ${f.path}: ${f.detail ?? "unreadable"}`);
  if ("error" in status.cli) {
    lines.push(`Reported by the CLI: ${status.cli.error}`);
  } else {
    lines.push(`Reported by the CLI (${status.cliCommand ?? "agent"} mcp list):`);
    if (status.cli.length === 0) lines.push("  (no servers)");
    for (const s of status.cli) lines.push(`  ${s.name}: ${s.status}${s.forwarded && needsApproval(s) ? "  (forwarded by the extension, so it is available in chat)" : ""}`);
  }
  return lines;
}
