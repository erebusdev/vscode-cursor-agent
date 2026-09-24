import { describe, expect, it } from "vitest";
import { collectMcpStatus, configFiles, formatMcpStatus, forwardedServers, parseMcpList, pluginHost } from "../src/extension/mcpStatus";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServersResult } from "../src/extension/session/mcpConfig";

const result: McpServersResult = {
  servers: [
    { name: "echo", command: "node", args: ["server.mjs", "--token", "secret"], env: [{ name: "TOKEN", value: "secret" }] },
    { type: "http", name: "jira", url: "https://mcp.example.com/secret-path?key=secret", headers: [] },
    { type: "sse", name: "events", url: "not a url?token=1", headers: [] },
  ],
  sources: [
    { path: "/home/me/.cursor/mcp.json", level: "user", names: ["echo", "jira"] },
    { path: "/proj/.cursor/mcp.json", level: "project", names: ["jira", "events"] },
  ],
};

describe("MCP status shaping", () => {
  it("attributes each forwarded server to the file that wins (project over user) and hides secrets", () => {
    expect(forwardedServers(result)).toEqual([
      { name: "echo", source: "user", transport: "stdio", target: "node" },
      { name: "jira", source: "project", transport: "http", target: "https://mcp.example.com" },
      { name: "events", source: "project", transport: "sse", target: "not a url" },
    ]);
  });

  it("summarises the config files", () => {
    const files = configFiles({
      servers: [],
      sources: [
        { path: "/a", level: "user", names: [], missing: true },
        { path: "/b", level: "project", names: [], error: "Not valid JSON" },
        { path: "/c", level: "project", names: ["x", "y"] },
      ],
    });
    expect(files).toEqual([
      { path: "/a", level: "user", state: "missing", count: 0 },
      { path: "/b", level: "project", state: "error", detail: "Not valid JSON", count: 0 },
      { path: "/c", level: "project", state: "ok", count: 2 },
    ]);
  });

  it("parses agent mcp list output, skipping colour codes, headings and diagnostics", () => {
    const output = [
      "\u001b[1mMCP servers\u001b[0m",
      "Loading…",
      "  jira: \u001b[33mneeds approval\u001b[0m",
      "- github: ready",
      "Warning: something odd",
      "see https://docs.cursor.com",
      "my server: disabled",
      "",
    ].join("\n");
    expect(parseMcpList(output, ["jira"])).toEqual([
      { name: "jira", status: "needs approval", forwarded: true },
      { name: "github", status: "ready", forwarded: false },
      { name: "my server", status: "disabled", forwarded: false },
    ]);
    expect(parseMcpList("No MCP servers configured\n")).toEqual([]);
  });
});

describe("collectMcpStatus", () => {
  const launch = { command: "agent", args: ["-e", "https://x"], env: { PATH: "/bin" } as NodeJS.ProcessEnv };

  it("runs `<agent> [args] mcp list` in the workspace and shapes the answer", async () => {
    const calls: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }> = [];
    const status = await collectMcpStatus({
      loadServers: async () => result,
      launch,
      cwd: "/proj",
      resolve: async () => ({ path: "/usr/local/bin/agent" }),
      run: async (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        return { stdout: "jira: needs approval\ngithub: ready\n", stderr: "" };
      },
      now: () => 42,
    });
    expect(calls).toEqual([{ file: "/usr/local/bin/agent", args: ["-e", "https://x", "mcp", "list"], cwd: "/proj" }]);
    expect(status.checkedAt).toBe(42);
    expect(status.cliCommand).toBe("/usr/local/bin/agent");
    expect(status.forwarded.map((s) => s.name)).toEqual(["echo", "jira", "events"]);
    expect(status.cli).toEqual([
      { name: "jira", status: "needs approval", forwarded: true },
      { name: "github", status: "ready", forwarded: false },
    ]);
    expect(formatMcpStatus(status).join("\n")).toContain("jira: needs approval  (forwarded by the extension, so it is available in chat)");
  });

  it("reports a missing executable or a failed run as an error, keeping the forwarded list", async () => {
    const missing = await collectMcpStatus({ loadServers: async () => result, launch, cwd: "/proj", resolve: async () => undefined, projectSkipped: "the workspace is not trusted" });
    expect(missing.cli).toEqual({ error: expect.stringContaining("not found") });
    expect(missing.forwarded).toHaveLength(3);
    expect(missing.projectSkipped).toBe("the workspace is not trusted");

    const failed = await collectMcpStatus({
      loadServers: async () => ({ servers: [], sources: [] }),
      launch,
      cwd: "/proj",
      resolve: async () => ({ path: "/bin/agent" }),
      run: async () => ({ stdout: "", stderr: "boom\n", error: new Error("exit 1") }),
    });
    expect("error" in failed.cli && failed.cli.error).toBe('Could not run "/bin/agent mcp list": exit 1\nboom');
    expect(formatMcpStatus(failed)).toContain("  (none: no mcp.json found)");
  });
});

describe("Cursor plugin servers in the MCP status", () => {
  it("shows only the host of a URL or the base name of a command", () => {
    expect(pluginHost({ url: "https://mcp.sentry.dev/mcp?token=secret" })).toBe("mcp.sentry.dev");
    expect(pluginHost({ command: "/opt/tools/bin/server.exe" })).toBe("server");
  });

  it("lists discovered servers with their mcp.json and CLI state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-status-plugins-"));
    try {
      const cursorDir = join(dir, ".cursor");
      const root = join(cursorDir, "plugins", "cache", "pub", "1", "sha");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp?utm_source=plugin", headers: { A: "secret" } }, other: { command: "node", args: ["--token", "secret"] } } }));
      writeFileSync(join(cursorDir, "plugins", "cache", ".cloud-plugin-manifest.json"), JSON.stringify({ plugins: [{ name: "sentry", pluginId: "1", marketplaceSlug: "pub", resolvedCommitSha: "sha" }] }));
      writeFileSync(join(cursorDir, "mcp.json"), JSON.stringify({ mcpServers: { "plugin-sentry-sentry": { url: "https://mcp.sentry.dev/mcp?utm_source=plugin" } } }));
      const status = await collectMcpStatus({
        loadServers: async () => ({ servers: [], sources: [] }),
        launch: { command: "agent", args: [], env: {} },
        cwd: dir,
        plugins: () => ({ mode: "auto", exclude: ["plugin-sentry-other"], config: { path: join(cursorDir, "mcp.json"), cursorDir, source: "agent" }, reconnectNeeded: false }),
        resolve: async () => ({ path: "/bin/agent" }),
        run: async () => ({ stdout: "plugin-sentry-sentry: requires_authentication\n", stderr: "" }),
        now: () => 1,
      });
      expect(status.plugins).toEqual([
        { id: "plugin-sentry-other", pluginName: "sentry", serverName: "other", transport: "stdio", host: "node", enabled: false, excluded: true },
        { id: "plugin-sentry-sentry", pluginName: "sentry", serverName: "sentry", transport: "http", host: "mcp.sentry.dev", enabled: true, excluded: false, cliStatus: "requires_authentication" },
      ]);
      expect(status).toMatchObject({ pluginMode: "auto", userConfigSource: "agent", userConfigPath: join(cursorDir, "mcp.json"), pluginErrors: [] });
      expect(JSON.stringify(status)).not.toContain("secret");
      expect(formatMcpStatus(status).join("\n")).toContain("plugin-sentry-sentry (http: mcp.sentry.dev): in mcp.json, requires_authentication");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
