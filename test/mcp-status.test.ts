import { describe, expect, it } from "vitest";
import { collectMcpStatus, configFiles, formatMcpStatus, forwardedServers, parseMcpList } from "../src/extension/mcpStatus";
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
