import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverPluginMcpServers, isServerEnabled, normaliseUrl, pluginServerId, readUserMcp, setPluginServers, UserMcpError } from "../src/extension/session/cursorPlugins";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cursor-plugins-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/** A cloud-installed plugin: manifest entry + live sha folder (+ a stale folder named after the plugin). */
function cloudPlugin(cursorDir: string, name: string, pluginId: string, files: Record<string, unknown>, sha = `${name}sha`): string {
  const root = join(cursorDir, "plugins", "cache", "cursor-public", pluginId, sha);
  for (const [file, content] of Object.entries(files)) write(join(root, file), content);
  writeFileSync(join(dirname(root), `${sha}.installed`), "");
  return root;
}

function manifest(cursorDir: string, plugins: Array<{ name: string; pluginId: string; sha?: string }>): void {
  write(join(cursorDir, "plugins", "cache", ".cloud-plugin-manifest.json"), {
    manifestVersion: "1",
    plugins: plugins.map((p) => ({ name: p.name, pluginId: p.pluginId, marketplaceSlug: "cursor-public", gitRef: p.sha ?? `${p.name}sha`, resolvedCommitSha: p.sha ?? `${p.name}sha`, gitUrl: "https://example.invalid/x.git" })),
  });
}

describe("plugin MCP discovery", () => {
  it("reads live plugins from the manifest and ignores stale folders named after plugins", () => {
    const cursorDir = join(dir, ".cursor");
    cloudPlugin(cursorDir, "sentry", "579", { "mcp.json": { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp?utm_source=plugin" } } } });
    // Stale copy: must not show up.
    write(join(cursorDir, "plugins", "cache", "cursor-public", "sentry", "old", ".mcp.json"), { mcpServers: { stale: { url: "https://stale.example" } } });
    manifest(cursorDir, [{ name: "sentry", pluginId: "579" }]);
    const found = discoverPluginMcpServers(cursorDir);
    expect(found.errors).toEqual([]);
    expect(found.complete).toBe(true);
    expect(found.servers).toEqual([
      { id: "plugin-sentry-sentry", pluginName: "sentry", serverName: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp?utm_source=plugin", entry: { url: "https://mcp.sentry.dev/mcp?utm_source=plugin" } },
    ]);
  });

  it("follows plugin.json (path or inline object), falls back to .mcp.json, expands placeholders, keeps headers, sorts", () => {
    const cursorDir = join(dir, ".cursor");
    cloudPlugin(cursorDir, "figma", "657", {
      ".cursor-plugin/plugin.json": { name: "figma", mcpServers: "./config/servers.json" },
      "config/servers.json": { mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp", headers: { "X-Figma-Plugin-Bundle": "cursor" } } } },
      ".mcp.json": { mcpServers: { ignored: { url: "https://ignored.example" } } },
    });
    cloudPlugin(cursorDir, "cloudflare", "407", {
      ".cursor-plugin/plugin.json": { name: "cloudflare" },
      ".mcp.json": { mcpServers: { "cloudflare-docs": { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" }, "cloudflare-bindings": { type: "sse", url: "https://bindings.mcp.cloudflare.com/sse" } } },
    });
    const localRoot = cloudPlugin(cursorDir, "tools", "900", {
      ".cursor-plugin/plugin.json": { name: "tools", mcp: { mcpServers: { run: { command: "${CURSOR_PLUGIN_ROOT}/bin/run", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"], env: { A: "1" } } } } },
    });
    cloudPlugin(cursorDir, "docs-canvas", "6306", { ".cursor-plugin/plugin.json": { name: "docs-canvas" } });
    manifest(cursorDir, [
      { name: "figma", pluginId: "657" },
      { name: "tools", pluginId: "900" },
      { name: "cloudflare", pluginId: "407" },
      { name: "docs-canvas", pluginId: "6306" },
    ]);
    const found = discoverPluginMcpServers(cursorDir);
    expect(found.errors).toEqual([]);
    expect(found.servers.map((s) => [s.id, s.transport])).toEqual([
      ["plugin-cloudflare-cloudflare-bindings", "sse"],
      ["plugin-cloudflare-cloudflare-docs", "http"],
      ["plugin-figma-figma", "http"],
      ["plugin-tools-run", "stdio"],
    ]);
    expect(found.servers[2]!.entry).toEqual({ type: "http", url: "https://mcp.figma.com/mcp", headers: { "X-Figma-Plugin-Bundle": "cursor" } });
    const tools = found.servers[3]!;
    expect(tools.command).toBe(`${localRoot}/bin/run`);
    expect(tools.entry).toEqual({ command: `${localRoot}/bin/run`, args: ["--root", localRoot], env: { A: "1" } });
  });

  it("reads local plugins that have a plugin.json and skips other folders", () => {
    const cursorDir = join(dir, ".cursor");
    write(join(cursorDir, "plugins", "local", "mine", ".cursor-plugin", "plugin.json"), { name: "my-plugin" });
    write(join(cursorDir, "plugins", "local", "mine", "mcp.json"), { mcpServers: { srv: { url: "https://local.example/mcp" } } });
    write(join(cursorDir, "plugins", "local", "unnamed", ".cursor-plugin", "plugin.json"), {});
    write(join(cursorDir, "plugins", "local", "unnamed", ".mcp.json"), { mcpServers: { x: { command: "node" } } });
    write(join(cursorDir, "plugins", "local", "no-manifest", ".mcp.json"), { mcpServers: { y: { command: "node" } } });
    const found = discoverPluginMcpServers(cursorDir);
    expect(found.servers.map((s) => s.id)).toEqual(["plugin-my-plugin-srv", "plugin-unnamed-x"]);
  });

  it("tolerates a missing plugins folder, a missing manifest and broken files", () => {
    expect(discoverPluginMcpServers(join(dir, "nothing"))).toEqual({ pluginsDir: join(dir, "nothing", "plugins"), servers: [], errors: [], complete: false });
    const cursorDir = join(dir, ".cursor");
    mkdirSync(join(cursorDir, "plugins", "cache"), { recursive: true });
    expect(discoverPluginMcpServers(cursorDir)).toMatchObject({ servers: [], errors: [], complete: true });

    cloudPlugin(cursorDir, "broken", "1", { ".mcp.json": "{ not json" });
    cloudPlugin(cursorDir, "odd", "2", { ".mcp.json": { mcpServers: { nothing: { type: "http" } } } });
    manifest(cursorDir, [
      { name: "broken", pluginId: "1" },
      { name: "odd", pluginId: "2" },
      { name: "missing", pluginId: "3" },
    ]);
    const found = discoverPluginMcpServers(cursorDir);
    expect(found.servers).toEqual([]);
    expect(found.errors).toHaveLength(3);
    expect(found.complete).toBe(false);

    write(join(cursorDir, "plugins", "cache", ".cloud-plugin-manifest.json"), "garbage");
    expect(discoverPluginMcpServers(cursorDir)).toMatchObject({ servers: [], complete: false });
  });

  it("names servers plugin-<plugin>-<server>", () => {
    expect(pluginServerId("atlassian", "atlassian")).toBe("plugin-atlassian-atlassian");
    expect(pluginServerId("cloudflare", "cloudflare-docs")).toBe("plugin-cloudflare-cloudflare-docs");
  });
});

describe("user-level mcp.json edits", () => {
  const sentry = { id: "plugin-sentry-sentry", url: "https://mcp.sentry.dev/mcp?utm_source=plugin", entry: { url: "https://mcp.sentry.dev/mcp?utm_source=plugin" } };
  const docs = { id: "plugin-cloudflare-cloudflare-docs", url: "https://docs.mcp.cloudflare.com/mcp", entry: { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" } };

  it("adds and removes entries, keeping every other key and entry, and the file mode", () => {
    const path = join(dir, "mcp.json");
    const original = { theme: { keep: true }, mcpServers: { github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer x" } }, "plugin-old-old": { command: "old" } }, zzz: 1 };
    write(path, original);
    chmodSync(path, 0o640);
    const result = setPluginServers(path, [sentry, docs], ["plugin-old-old"]);
    expect(result).toEqual({ added: [sentry.id, docs.id], removed: ["plugin-old-old"], changed: true });
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "theme": {');
    const data = JSON.parse(text);
    expect(Object.keys(data)).toEqual(["theme", "mcpServers", "zzz"]);
    expect(data.mcpServers).toEqual({ github: original.mcpServers.github, [sentry.id]: sentry.entry, [docs.id]: docs.entry });
    // Windows has no Unix permission bits.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["mcp.json"]);

    // Nothing to do: no write.
    const before = statSync(path).mtimeMs;
    expect(setPluginServers(path, [sentry], [])).toEqual({ added: [], removed: [], changed: false });
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("creates a missing file with mode 0600", () => {
    const path = join(dir, "new", "mcp.json");
    mkdirSync(dirname(path));
    setPluginServers(path, [docs], []);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: { [docs.id]: docs.entry } });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a server as already enabled when any entry has the same URL (trailing slash ignored, query kept)", () => {
    const servers = { "my-sentry": { url: "https://MCP.sentry.dev/mcp/?utm_source=plugin" } };
    expect(isServerEnabled(servers, sentry)).toBe(true);
    expect(isServerEnabled({ x: { url: "https://mcp.sentry.dev/mcp" } }, sentry)).toBe(false);
    expect(isServerEnabled({ [sentry.id]: {} }, sentry)).toBe(true);
    expect(normaliseUrl("https://A.example/x/?q=1")).toBe("https://a.example/x?q=1");
    const path = join(dir, "mcp.json");
    write(path, { mcpServers: servers });
    expect(setPluginServers(path, [sentry], []).changed).toBe(false);
  });

  it("refuses to touch a file that is not valid JSON", () => {
    const path = join(dir, "mcp.json");
    write(path, '{ "mcpServers": { ,');
    expect(() => readUserMcp(path)).toThrow(UserMcpError);
    expect(() => setPluginServers(path, [docs], [])).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe('{ "mcpServers": { ,');
    write(path, "[]");
    expect(() => setPluginServers(path, [docs], [])).toThrow(/JSON object/);
    expect(existsSync(path)).toBe(true);
  });
});

// Read-only check against a real Cursor folder: CURSOR_PLUGINS_REAL_DIR=/path/to/.cursor npx vitest run test/cursor-plugins.test.ts
describe.skipIf(!process.env.CURSOR_PLUGINS_REAL_DIR)("real Cursor folder (read-only)", () => {
  it("discovers plugin servers", () => {
    const found = discoverPluginMcpServers(process.env.CURSOR_PLUGINS_REAL_DIR!);
    // Ids and transports only: URLs may carry queries and entries may carry headers.
    const current = readUserMcp(join(process.env.CURSOR_PLUGINS_REAL_DIR!, "mcp.json")).servers;
    console.log(JSON.stringify({ servers: found.servers.map((s) => `${s.id} (${s.transport})${isServerEnabled(current, s) ? " already in mcp.json" : ""}`), errors: found.errors.length, complete: found.complete }, null, 2));
    expect(found.servers.length).toBeGreaterThan(0);
  });
});
