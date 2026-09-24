import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectProcessHome, homeCandidatesFromPs, homeFromEnviron, planPluginSync, PluginMcpSync, resolveUserMcpConfig, safeToSync, type PluginSyncSettings } from "../src/extension/pluginSync";
import type { PluginMcpServer } from "../src/extension/session/cursorPlugins";

describe("agent HOME detection", () => {
  it("reads HOME from ps -E output, values with spaces included, last one first", () => {
    const out = "/usr/local/bin/node /opt/agent/index.js acp --flag HOME=/not/this TERM=xterm HOME=/Users/me/Agent Homes/work PATH=/usr/bin:/bin USER=me\n";
    expect(homeCandidatesFromPs(out)).toEqual(["/Users/me/Agent Homes/work", "/not/this"]);
    expect(homeCandidatesFromPs("node index.js acp HOME=/h")).toEqual(["/h"]);
    expect(homeCandidatesFromPs("node index.js acp PATH=/bin")).toEqual([]);
    // Lower-case words after a space do not end the value.
    expect(homeCandidatesFromPs("x HOME=/a b=c LANG=C")).toEqual(["/a b=c"]);
  });

  it("reads HOME from a /proc environ buffer", () => {
    expect(homeFromEnviron(Buffer.from("PATH=/bin\0HOME=/home/me work\0USER=me\0"))).toBe("/home/me work");
    expect(homeFromEnviron("PATH=/bin\0")).toBeUndefined();
  });

  it("keeps only candidates that are existing folders, and skips Windows", async () => {
    const dirs = new Set(["/not/this"]);
    const isDirectory = async (p: string) => dirs.has(p);
    const runPs = async () => "node acp HOME=/not/this HOME=/gone";
    expect(await detectProcessHome(42, { platform: "darwin", runPs, isDirectory })).toBe("/not/this");
    expect(await detectProcessHome(42, { platform: "linux", readEnviron: async () => Buffer.from("HOME=/not/this\0"), isDirectory })).toBe("/not/this");
    expect(await detectProcessHome(42, { platform: "linux", readEnviron: async () => Buffer.from("HOME=/gone\0"), isDirectory })).toBeUndefined();
    expect(await detectProcessHome(42, { platform: "win32", isDirectory })).toBeUndefined();
    expect(await detectProcessHome(undefined, { platform: "darwin", runPs, isDirectory })).toBeUndefined();
    expect(await detectProcessHome(42, { platform: "darwin", runPs: async () => Promise.reject(new Error("no ps")), isDirectory })).toBeUndefined();
  });
});

describe("which user-level mcp.json", () => {
  const base = { homedir: "/Users/me", windows: false };
  it("prefers the setting, then HOME in the environment setting, then the agent process, then the home folder", () => {
    // Paths are built with the platform's separator, as the code does.
    const at = (...parts: string[]) => ({ path: join(...parts, "mcp.json"), cursorDir: join(...parts) });
    expect(resolveUserMcpConfig({ ...base, setting: "~/custom/mcp.json", environment: { HOME: "/env" }, agentHome: "/agent" })).toEqual({ ...at("/Users/me", "custom"), source: "settings" });
    expect(resolveUserMcpConfig({ ...base, setting: " ", environment: { HOME: "/env/home" }, agentHome: "/agent" })).toEqual({ ...at("/env/home", ".cursor"), source: "environment" });
    expect(resolveUserMcpConfig({ ...base, setting: "", environment: { OTHER: "x" }, agentHome: "/agent" })).toEqual({ ...at("/agent", ".cursor"), source: "agent" });
    expect(resolveUserMcpConfig({ ...base, setting: "", environment: {} })).toEqual({ ...at("/Users/me", ".cursor"), source: "default" });
  });

  it("uses USERPROFILE before HOME on Windows", () => {
    expect(resolveUserMcpConfig({ setting: "", environment: { HOME: "/h", USERPROFILE: "/p" }, homedir: "/x", windows: true }).source).toBe("environment");
    expect(resolveUserMcpConfig({ setting: "", environment: { HOME: "/h", USERPROFILE: "/p" }, homedir: "/x", windows: true }).cursorDir).toMatch(/^[\\/]p[\\/]\.cursor$/);
    expect(resolveUserMcpConfig({ setting: "", environment: { HOME: "/h", USERPROFILE: "/p" }, homedir: "/x", windows: false }).cursorDir).toBe(join("/h", ".cursor"));
  });

  it("only syncs a non-.cursor/mcp.json file when it was set explicitly", () => {
    expect(safeToSync({ path: "/a/b.json", cursorDir: "/a", source: "settings" })).toBe(true);
    expect(safeToSync({ path: "/a/b.json", cursorDir: "/a", source: "agent" })).toBe(false);
    expect(safeToSync({ path: "/a/.cursor/mcp.json", cursorDir: "/a/.cursor", source: "agent" })).toBe(true);
  });
});

const server = (plugin: string, name: string, url: string): PluginMcpServer => ({ id: `plugin-${plugin}-${name}`, pluginName: plugin, serverName: name, transport: "http", url, entry: { url } });
const sentry = server("sentry", "sentry", "https://mcp.sentry.dev/mcp");
const figma = server("figma", "figma", "https://mcp.figma.com/mcp");

describe("sync plan", () => {
  it("adds what is missing, skips excluded and already-present servers, and tracks what it added", () => {
    const plan = planPluginSync({ discovery: { servers: [figma, sentry], complete: true }, current: { mine: { url: "https://mcp.figma.com/mcp/" } }, exclude: [], managed: [] });
    expect(plan.add.map((s) => s.id)).toEqual([sentry.id]);
    expect(plan.remove).toEqual([]);
    expect(plan.managed).toEqual([sentry.id]);
  });

  it("removes excluded or uninstalled plugin entries whoever added them, and never touches custom servers", () => {
    const current = { github: {}, [sentry.id]: {}, [figma.id]: {}, "plugin-gone-gone": {} };
    const plan = planPluginSync({ discovery: { servers: [figma, sentry], complete: true }, current, exclude: [sentry.id, figma.id], managed: [sentry.id] });
    expect(plan.add).toEqual([]);
    expect([...plan.remove].sort()).toEqual([figma.id, "plugin-gone-gone", sentry.id].sort());
    expect(plan.managed).toEqual([]);
  });

  it("keeps entries of plugins it cannot see when discovery was incomplete, and is unchanged when in sync", () => {
    const current = { [sentry.id]: {}, "plugin-gone-gone": {} };
    expect(planPluginSync({ discovery: { servers: [sentry], complete: false }, current, exclude: [], managed: [sentry.id, "plugin-gone-gone"] })).toEqual({ add: [], remove: [], managed: ["plugin-gone-gone", sentry.id] });
    // A managed id the user deleted by hand is forgotten, then re-added.
    expect(planPluginSync({ discovery: { servers: [sentry], complete: true }, current: {}, exclude: [], managed: [sentry.id] }).add).toEqual([sentry]);
  });
});

describe("PluginMcpSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugin-sync-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function install(home: string): string {
    const cursorDir = join(home, ".cursor");
    const root = join(cursorDir, "plugins", "cache", "pub", "1", "sha");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { sentry: { url: sentry.url } } }));
    writeFileSync(join(cursorDir, "plugins", "cache", ".cloud-plugin-manifest.json"), JSON.stringify({ plugins: [{ name: "sentry", pluginId: "1", marketplaceSlug: "pub", resolvedCommitSha: "sha" }] }));
    const mcp = join(cursorDir, "mcp.json");
    writeFileSync(mcp, JSON.stringify({ mcpServers: { github: { url: "https://gh.example" } } }));
    return mcp;
  }

  function make(settings: Partial<PluginSyncSettings>, detected?: string, state = new Map<string, unknown>()) {
    const current: PluginSyncSettings = { mode: "auto", exclude: [], userConfig: "", environment: {}, ...settings };
    const logs: string[] = [];
    const sync = new PluginMcpSync({
      settings: () => current,
      setExclude: async (ids) => {
        (current as { exclude: ReadonlyArray<string> }).exclude = ids;
      },
      setSkillsExclude: async (entries) => {
        (current as { skillsExclude?: ReadonlyArray<string> }).skillsExclude = entries;
      },
      store: { get: <T>(k: string) => state.get(k) as T | undefined, update: (k, v) => void state.set(k, v) },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      detectHome: async () => detected,
      homedir: () => join(dir, "vscode-home"),
      windows: false,
    });
    return { sync, state, logs, settings: current };
  }
  const launch = { command: "/bin/wrapper", args: ["--x"] };
  const servers = (path: string) => Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers);

  it("learns the agent HOME after initialize, syncs once, then syncs before later launches", async () => {
    const agentHome = join(dir, "agent-home");
    const mcp = install(agentHome);
    const { sync, state } = make({}, agentHome);
    await sync.beforeSpawn(launch);
    expect(servers(mcp)).toEqual(["github"]);
    expect(await sync.afterInitialize(launch, 123)).toBe(true);
    expect(servers(mcp)).toEqual(["github", sentry.id]);
    expect(await sync.afterInitialize(launch, 124)).toBe(false);
    expect(sync.resolve(launch)).toMatchObject({ path: mcp, source: "agent" });

    // A fresh extension session remembers the HOME and syncs before spawning.
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
    const reloaded = make({}, agentHome, new Map(state)).sync;
    await reloaded.beforeSpawn(launch);
    expect(servers(mcp)).toEqual([sentry.id]);
    expect(await reloaded.afterInitialize(launch, 125)).toBe(false);
  });

  it("uses HOME from the environment setting without asking the process", async () => {
    const envHome = join(dir, "env-home");
    const mcp = install(envHome);
    const { sync } = make({ environment: { HOME: envHome } }, join(dir, "elsewhere"));
    await sync.beforeSpawn(launch);
    expect(servers(mcp)).toEqual(["github", sentry.id]);
    expect(await sync.afterInitialize(launch, 1)).toBe(false);
    expect(sync.resolve(launch).source).toBe("environment");
  });

  it("switching a server off excludes it and removes its plugin entry, leaving custom servers alone", async () => {
    const home = join(dir, "h");
    const mcp = install(home);
    const { sync, settings } = make({ environment: { HOME: home } });
    await sync.beforeSpawn(launch);
    const off = await sync.setEnabled([sentry.id], false);
    expect(off).toMatchObject({ changed: true, removed: [sentry.id] });
    expect(settings.exclude).toEqual([sentry.id]);
    expect(servers(mcp)).toEqual(["github"]);
    expect(sync.reconnectNeeded).toBe(true);
    await sync.setEnabled([sentry.id], true);
    expect(settings.exclude).toEqual([]);
    expect(servers(mcp)).toEqual(["github", sentry.id]);

    // A plugin entry is the plugin's even if someone wrote it by hand; custom servers are never touched.
    writeFileSync(mcp, JSON.stringify({ mcpServers: { github: { url: "https://example.test/mcp" }, [sentry.id]: { url: sentry.url } } }));
    const fresh = make({ environment: { HOME: home } });
    await fresh.sync.setEnabled([sentry.id], false);
    expect(servers(mcp)).toEqual(["github"]);
  });

  it("manual mode writes only on request; off mode never writes", async () => {
    const home = join(dir, "m");
    const mcp = install(home);
    const manual = make({ mode: "manual", environment: { HOME: home } });
    await manual.sync.beforeSpawn(launch);
    expect(servers(mcp)).toEqual(["github"]);
    await manual.sync.setEnabled([sentry.id], true);
    expect(servers(mcp)).toEqual(["github", sentry.id]);
    await manual.sync.setEnabled([sentry.id], false);
    expect(servers(mcp)).toEqual(["github"]);
    const off = make({ mode: "off", environment: { HOME: home } });
    await off.sync.beforeSpawn(launch);
    expect(await off.sync.setEnabled([sentry.id], true)).toMatchObject({ changed: false });
    expect(servers(mcp)).toEqual(["github"]);
  });

  it("does not sync a detected file that is not .cursor/mcp.json, and reports invalid JSON without writing", async () => {
    const home = join(dir, "bad");
    const mcp = install(home);
    writeFileSync(mcp, "{ nope");
    const { sync, logs } = make({ environment: { HOME: home } });
    await sync.beforeSpawn(launch);
    expect(readFileSync(mcp, "utf8")).toBe("{ nope");
    expect(logs.join("\n")).toMatch(/not valid JSON/);
    expect(await sync.sync({ path: join(dirname(mcp), "other.json"), cursorDir: dirname(mcp), source: "agent" })).toMatchObject({ changed: false, error: expect.stringMatching(/not a .cursor\/mcp.json/) });
  });

  it("links plugin skills on connect in any MCP mode, counts them towards the restart, and unlinks per plugin", async () => {
    const agentHome = join(dir, "agent-home");
    const mcp = install(agentHome);
    const cursorDir = dirname(mcp);
    const skill = join(cursorDir, "plugins", "cache", "pub", "1", "sha", "skills", "sentry-debug-issue");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\ndescription: Debug a Sentry issue\n---\n");
    const { sync, settings } = make({ mode: "off", skills: true }, agentHome);
    await sync.beforeSpawn(launch);
    expect(await sync.afterInitialize(launch, 1)).toBe(true);
    expect(servers(mcp)).toEqual(["github"]); // MCP mode off: mcp.json untouched
    expect(lstatSync(join(cursorDir, "skills", "sentry-debug-issue")).isSymbolicLink()).toBe(true);
    expect(sync.commandInfo("sentry-debug-issue")).toEqual({ pluginName: "sentry", description: "Debug a Sentry issue" });

    const outcome = await sync.setSkillsEnabled(["sentry"], false, launch);
    expect(settings.skillsExclude).toEqual(["sentry"]);
    expect(outcome.removed).toEqual(["sentry-debug-issue"]);
    expect(sync.reconnectNeeded).toBe(true);
    expect(existsSync(join(cursorDir, "skills", "sentry-debug-issue"))).toBe(false);
    expect(sync.commandInfo("sentry-debug-issue")).toBeUndefined();
    await sync.setSkillsEnabled(["sentry"], true, launch);
    expect(settings.skillsExclude).toEqual([]);
    expect(existsSync(join(cursorDir, "skills", "sentry-debug-issue", "SKILL.md"))).toBe(true);
  });
});
