import { describe, expect, it } from "vitest";
import { describeMcpServers, loadMcpServers, parseMcpConfig } from "../src/extension/session/mcpConfig";
import { mergePath } from "../src/extension/hostEnv";
import { mcpPatternFrom } from "../src/extension/session/approvals";

const env = { HOME: "/home/mel", TOKEN: "secret" } as NodeJS.ProcessEnv;

describe("Cursor mcp.json → ACP mcpServers", () => {
  it("converts stdio and remote servers, resolving ${env:VAR}", () => {
    const text = JSON.stringify({
      mcpServers: {
        echo: { command: "node", args: ["server.mjs", "--token", "${env:TOKEN}"], env: { PROBE: "1", MISSING: "${env:NOPE}" } },
        jira: { url: "https://mcp.example/${env:TOKEN}", headers: { Authorization: "Bearer ${env:TOKEN}" } },
        events: { url: "https://mcp.example/sse", type: "sse" },
        off: { command: "never", disabled: true },
        junk: { nothing: true },
      },
    });
    const { servers, error } = parseMcpConfig(text, { env, baseDir: "/proj" });
    expect(error).toBeUndefined();
    expect(servers).toEqual([
      { name: "echo", command: "node", args: ["server.mjs", "--token", "secret"], env: [{ name: "PROBE", value: "1" }, { name: "MISSING", value: "" }] },
      { type: "http", name: "jira", url: "https://mcp.example/secret", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { type: "sse", name: "events", url: "https://mcp.example/sse", headers: [] },
    ]);
  });

  it("anchors relative commands and working directories to the project", () => {
    const { servers } = parseMcpConfig(JSON.stringify({ mcpServers: { local: { command: "./bin/server", cwd: "tools" } } }), { env, baseDir: "/proj" });
    expect(servers).toEqual([{ name: "local", command: "/proj/bin/server", args: [], env: [], cwd: "/proj/tools" }]);
  });

  it("reports unusable files instead of throwing", () => {
    expect(parseMcpConfig("{ not json", { env, baseDir: "/p" }).error).toMatch(/Not valid JSON/);
    expect(parseMcpConfig(JSON.stringify({ servers: {} }), { env, baseDir: "/p" }).error).toMatch(/mcpServers/);
  });

  it("reads user then project files, project winning on name clashes, and tolerates missing files", async () => {
    const files: Record<string, string> = {
      "/home/mel/.cursor/mcp.json": JSON.stringify({ mcpServers: { github: { command: "gh-mcp" }, shared: { command: "user-version" } } }),
      "/proj/.cursor/mcp.json": JSON.stringify({ mcpServers: { shared: { command: "project-version" }, local: { url: "http://localhost:1" } } }),
    };
    const readText = async (path: string) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    };
    const result = await loadMcpServers({ projectDir: "/proj", userConfigPath: "~/.cursor/mcp.json", env, readText });
    expect(result.servers.map((s) => s.name)).toEqual(["github", "shared", "local"]);
    expect(result.servers.find((s) => s.name === "shared")).toMatchObject({ command: "project-version" });
    expect(describeMcpServers(result)).toEqual(["user /home/mel/.cursor/mcp.json: github, shared", "project /proj/.cursor/mcp.json: shared, local"]);

    const none = await loadMcpServers({ projectDir: "/elsewhere", env, readText });
    expect(none.servers).toEqual([]);
    expect(none.sources[0]).toMatchObject({ missing: true });
    expect(describeMcpServers(none)).toEqual([]);
  });
});

describe("login-shell PATH", () => {
  it("puts login entries first and drops duplicates", () => {
    expect(mergePath("/opt/bin:/usr/bin", "/usr/bin:/bin", ":")).toBe("/opt/bin:/usr/bin:/bin");
    expect(mergePath(undefined, "/usr/bin", ":")).toBe("/usr/bin");
    expect(mergePath(undefined, undefined, ":")).toBeUndefined();
  });
});

describe("MCP permission patterns", () => {
  it("rebuilds Cursor's Mcp(server:tool) key from the raw input or the title", () => {
    expect(mcpPatternFrom({ providerIdentifier: "plugin-atlassian-atlassian", toolName: "searchJiraIssuesUsingJql", args: {} }, "x")).toBe("Mcp(plugin-atlassian-atlassian:searchJiraIssuesUsingJql)");
    expect(mcpPatternFrom(undefined, "echoprobe-echo_probe: echo_probe")).toBe("Mcp(echoprobe:echo_probe)");
    expect(mcpPatternFrom(undefined, "plugin-atlassian-atlassian-getJiraIssue: getJiraIssue")).toBe("Mcp(plugin-atlassian-atlassian:getJiraIssue)");
    expect(mcpPatternFrom(undefined, "echoprobe: echo_probe")).toBe("Mcp(echoprobe:echo_probe)");
    expect(mcpPatternFrom(undefined, "MCP: tool")).toBeUndefined();
    expect(mcpPatternFrom({ command: "ls" }, "`ls`")).toBeUndefined();
  });
});
