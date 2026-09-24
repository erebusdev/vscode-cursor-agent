import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySkillPlan, currentSkillPlan, discoverPluginSkills, frontmatterDescription, isPluginTarget, planSkillSync, readLinkEntries, type LinkEntry, type PluginSkill } from "../src/extension/session/cursorPluginSkills";

let dir: string;
let cursorDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-skills-"));
  cursorDir = join(dir, ".cursor");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const skillMd = (description: string) => `---\nname: whatever\ndescription: ${description}\n---\n\n# Body\n`;

interface Entry {
  name: string;
  pluginId: string;
  sha?: string;
  gitPath?: string;
  skill?: string[];
  command?: string[];
}

function manifest(plugins: Entry[]): void {
  write(
    join(cursorDir, "plugins", "cache", ".cloud-plugin-manifest.json"),
    JSON.stringify({
      manifestVersion: "1",
      plugins: plugins.map((p) => ({
        name: p.name,
        pluginId: p.pluginId,
        marketplaceSlug: "cursor-public",
        gitRef: p.sha ?? "sha1",
        resolvedCommitSha: p.sha ?? "sha1",
        ...(p.gitPath ? { gitPath: p.gitPath } : {}),
        ...(p.skill || p.command ? { declaredCapabilityPaths: { skill: p.skill ?? [], command: p.command ?? [], subagent: [] } } : {}),
      })),
    }),
  );
}

function pluginRoot(pluginId: string, sha = "sha1"): string {
  return join(cursorDir, "plugins", "cache", "cursor-public", pluginId, sha);
}

/** Sentry with two skills, Cloudflare with one skill and one command, docs-canvas declared with its gitPath prefix. */
function fixture(): void {
  write(join(pluginRoot("579"), "skills", "sentry-debug-issue", "SKILL.md"), skillMd("Debug a Sentry issue"));
  write(join(pluginRoot("579"), "skills", "sentry-get-started", "SKILL.md"), skillMd('"Set up Sentry"'));
  write(join(pluginRoot("407"), "skills", "wrangler", "SKILL.md"), skillMd("Use wrangler"));
  write(join(pluginRoot("407"), "commands", "build-agent.md"), "---\ndescription: Build an agent\n---\nDo it.\n");
  write(join(pluginRoot("6306"), "skills", "docs-canvas", "SKILL.md"), skillMd("Docs canvas"));
  manifest([
    { name: "sentry", pluginId: "579", skill: ["skills/sentry-debug-issue/SKILL.md", "skills/sentry-get-started/SKILL.md"] },
    { name: "cloudflare", pluginId: "407", skill: ["skills/wrangler/SKILL.md"], command: ["commands/build-agent.md"] },
    { name: "docs-canvas", pluginId: "6306", gitPath: "docs-canvas", skill: ["docs-canvas/skills/docs-canvas/SKILL.md"] },
  ]);
}

describe("plugin skill discovery", () => {
  it("reads skills and commands from the manifest's declared paths, gitPath prefix included", () => {
    fixture();
    const found = discoverPluginSkills(cursorDir);
    expect(found.errors).toEqual([]);
    expect(found.complete).toBe(true);
    expect(found.skills.map((s) => `${s.pluginName}:${s.kind}:${s.name}:${s.description}`)).toEqual([
      "cloudflare:command:build-agent:Build an agent",
      "cloudflare:skill:wrangler:Use wrangler",
      "docs-canvas:skill:docs-canvas:Docs canvas",
      "sentry:skill:sentry-debug-issue:Debug a Sentry issue",
      "sentry:skill:sentry-get-started:Set up Sentry",
    ]);
    expect(found.skills.find((s) => s.name === "wrangler")!.source).toBe(join(pluginRoot("407"), "skills", "wrangler"));
    expect(found.skills.find((s) => s.name === "build-agent")!.source).toBe(join(pluginRoot("407"), "commands", "build-agent.md"));
  });

  it("reports declared paths that are missing and falls back to the default layout without a declaration", () => {
    write(join(pluginRoot("1"), "skills", "a", "SKILL.md"), skillMd("A"));
    write(join(pluginRoot("1"), "skills", "not-a-skill", "README.md"), "x");
    write(join(pluginRoot("1"), "commands", "go.md"), "Go");
    write(join(pluginRoot("2"), "skills", "b", "SKILL.md"), skillMd("B"));
    manifest([{ name: "plain", pluginId: "1" }, { name: "broken", pluginId: "2", skill: ["skills/b/SKILL.md", "skills/gone/SKILL.md", "../../escape/SKILL.md"] }]);
    const found = discoverPluginSkills(cursorDir);
    expect(found.skills.map((s) => `${s.pluginName}:${s.kind}:${s.name}`)).toEqual(["broken:skill:b", "plain:command:go", "plain:skill:a"]);
    expect(found.errors).toEqual(["broken: skill skills/gone/SKILL.md not found", "broken: skill ../../escape/SKILL.md not found"]);
  });

  it("parses single-line, quoted and folded descriptions", () => {
    expect(frontmatterDescription("---\ndescription: One line\n---\n")).toBe("One line");
    expect(frontmatterDescription("---\ndescription: 'Quoted: yes'\n---\n")).toBe("Quoted: yes");
    expect(frontmatterDescription("---\nname: x\ndescription: >\n  Folded\n  text\nother: y\n---\n")).toBe("Folded text");
    expect(frontmatterDescription("No frontmatter")).toBeUndefined();
  });
});

describe("ownership of skills entries", () => {
  it("only links into the plugins folder are managed; real folders and foreign links are the user's", () => {
    fixture();
    const skills = join(cursorDir, "skills");
    mkdirSync(join(skills, "my-own"), { recursive: true });
    mkdirSync(join(dir, "elsewhere", "shared"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "shared"), join(skills, "shared"));
    symlinkSync(join(pluginRoot("579"), "skills", "sentry-debug-issue"), join(skills, "sentry-debug-issue"));
    // Relative link into plugins counts too.
    symlinkSync(join("..", "plugins", "cache", "cursor-public", "407", "sha1", "skills", "wrangler"), join(skills, "wrangler"));
    const entries = readLinkEntries(skills, "skill", [join(cursorDir, "plugins")], false);
    expect(entries.get("my-own")).toEqual({ managed: false });
    expect(entries.get("shared")).toEqual({ managed: false });
    expect(entries.get("sentry-debug-issue")).toEqual({ managed: true, target: join(pluginRoot("579"), "skills", "sentry-debug-issue") });
    expect(entries.get("wrangler")).toEqual({ managed: true, target: join(pluginRoot("407"), "skills", "wrangler") });
  });

  it("handles Windows junction targets (\\\\?\\ prefix, other case) with the platform flag", () => {
    const plugins = ["C:\\Users\\me\\.cursor\\plugins"];
    expect(isPluginTarget("\\\\?\\C:\\Users\\me\\.cursor\\plugins\\cache\\x\\1\\sha\\skills\\a\\", plugins, true)).toBe(true);
    expect(isPluginTarget("c:\\users\\ME\\.cursor\\Plugins\\cache\\a", plugins, true)).toBe(true);
    expect(isPluginTarget("C:\\Users\\me\\.cursor\\plugins-old\\a", plugins, true)).toBe(false);
    expect(isPluginTarget("C:\\Users\\me\\.cursor\\plugins", plugins, true)).toBe(false);
    expect(isPluginTarget("/Users/me/.cursor/plugins/cache/a", ["/Users/me/.cursor/plugins"], false)).toBe(true);
    expect(isPluginTarget("/Users/me/.cursor/Plugins/cache/a", ["/Users/me/.cursor/plugins"], false)).toBe(false);
    expect(isPluginTarget("/Users/me/.cursor/plugins/../skills/a", ["/Users/me/.cursor/plugins"], false)).toBe(false);
  });
});

const skill = (pluginName: string, name: string, kind: "skill" | "command" = "skill"): PluginSkill => ({ kind, name, pluginName, source: `/c/plugins/${pluginName}/${kind}s/${name}${kind === "command" ? ".md" : ""}` });
const managed = (target: string): LinkEntry => ({ managed: true, target });

describe("skill sync plan", () => {
  const base = { commands: new Map<string, LinkEntry>(), exclude: [], enabled: true, windows: false, targetExists: () => true };

  it("adds missing links, keeps current ones, replaces links to an old version, removes uninstalled ones", () => {
    const plan = planSkillSync({
      ...base,
      discovery: { complete: true, skills: [skill("sentry", "a"), skill("sentry", "b"), skill("figma", "c")] },
      skills: new Map<string, LinkEntry>([
        ["a", managed("/c/plugins/sentry/skills/a")],
        ["c", managed("/c/plugins/figma-old/skills/c")],
        ["gone", managed("/c/plugins/x/skills/gone")],
      ]),
    });
    expect(plan.entries.map((e) => `${e.skill.name}:${e.state}`)).toEqual(["a:linked", "b:missing", "c:missing"]);
    expect(plan.add.map((s) => s.name)).toEqual(["b", "c"]);
    expect(plan.remove).toEqual([{ kind: "skill", name: "c" }, { kind: "skill", name: "gone" }]);
  });

  it("skips names taken by the user's own skills or by an earlier plugin", () => {
    const plan = planSkillSync({
      ...base,
      discovery: { complete: true, skills: [skill("a", "dup"), skill("b", "dup"), skill("b", "mine")] },
      skills: new Map<string, LinkEntry>([["mine", { managed: false }]]),
    });
    expect(plan.entries.map((e) => `${e.skill.pluginName}/${e.skill.name}:${e.state}`)).toEqual(["a/dup:missing", "b/dup:clash", "b/mine:clash"]);
    expect(plan.add.map((s) => `${s.pluginName}/${s.name}`)).toEqual(["a/dup"]);
    expect(plan.remove).toEqual([]);
  });

  it("excludes whole plugins or single skills, and removes everything when switched off", () => {
    const discovery = { complete: true, skills: [skill("sentry", "a"), skill("sentry", "b"), skill("figma", "c"), skill("cf", "go", "command")] };
    const skills = new Map<string, LinkEntry>([["a", managed("/c/plugins/sentry/skills/a")], ["c", managed("/c/plugins/figma/skills/c")]]);
    const commands = new Map<string, LinkEntry>([["go", managed("/c/plugins/cf/commands/go.md")]]);
    const excluded = planSkillSync({ ...base, discovery, skills, commands, exclude: ["figma", "sentry/b"] });
    expect(excluded.entries.map((e) => `${e.skill.name}:${e.state}`)).toEqual(["a:linked", "b:off", "c:off", "go:linked"]);
    expect(excluded.remove).toEqual([{ kind: "skill", name: "c" }]);
    const off = planSkillSync({ ...base, discovery, skills, commands, enabled: false });
    expect(off.add).toEqual([]);
    expect(off.remove).toEqual([{ kind: "skill", name: "a" }, { kind: "skill", name: "c" }, { kind: "command", name: "go" }]);
  });

  it("keeps links of plugins not downloaded yet unless broken, and skips commands on Windows", () => {
    const skills = new Map<string, LinkEntry>([["later", managed("/c/plugins/p/skills/later")], ["broken", managed("/c/plugins/q/skills/broken")]]);
    const plan = planSkillSync({ ...base, discovery: { complete: false, skills: [skill("cf", "go", "command")] }, skills, windows: true, targetExists: (p) => p.includes("later") });
    expect(plan.remove).toEqual([{ kind: "skill", name: "broken" }]);
    expect(plan.entries).toEqual([]);
  });
});

describe("applying the skill sync", () => {
  it("links skills and commands, then removes them again, leaving the user's entries alone", () => {
    fixture();
    mkdirSync(join(cursorDir, "skills", "wrangler"), { recursive: true }); // the user's own skill of the same name
    write(join(cursorDir, "skills", "wrangler", "SKILL.md"), skillMd("Mine"));
    const discovery = discoverPluginSkills(cursorDir);
    const plan = currentSkillPlan(cursorDir, discovery, [], true, false);
    expect(plan.entries.filter((e) => e.state === "clash").map((e) => e.skill.name)).toEqual(["wrangler"]);
    const result = applySkillPlan(cursorDir, plan, false);
    expect(result.errors).toEqual([]);
    expect(result.added).toEqual(["build-agent.md", "docs-canvas", "sentry-debug-issue", "sentry-get-started"]);
    expect(readlinkSync(join(cursorDir, "skills", "sentry-debug-issue"))).toBe(join(pluginRoot("579"), "skills", "sentry-debug-issue"));
    expect(existsSync(join(cursorDir, "skills", "sentry-debug-issue", "SKILL.md"))).toBe(true);
    expect(lstatSync(join(cursorDir, "commands", "build-agent.md")).isSymbolicLink()).toBe(true);

    // Nothing left to do.
    const again = currentSkillPlan(cursorDir, discoverPluginSkills(cursorDir), [], true, false);
    expect(again.add).toEqual([]);
    expect(again.remove).toEqual([]);

    const off = applySkillPlan(cursorDir, currentSkillPlan(cursorDir, discovery, [], false, false), false);
    expect(off.removed).toEqual(["docs-canvas", "sentry-debug-issue", "sentry-get-started", "build-agent.md"]);
    expect(existsSync(join(cursorDir, "skills", "wrangler", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cursorDir, "skills", "sentry-debug-issue"))).toBe(false);
  });

  it("relinks when a plugin moves to a new version", () => {
    fixture();
    applySkillPlan(cursorDir, currentSkillPlan(cursorDir, discoverPluginSkills(cursorDir), [], true, false), false);
    write(join(pluginRoot("579", "sha2"), "skills", "sentry-debug-issue", "SKILL.md"), skillMd("New"));
    manifest([{ name: "sentry", pluginId: "579", sha: "sha2", skill: ["skills/sentry-debug-issue/SKILL.md"] }]);
    const result = applySkillPlan(cursorDir, currentSkillPlan(cursorDir, discoverPluginSkills(cursorDir), [], true, false), false);
    expect(result.added).toEqual(["sentry-debug-issue"]);
    expect([...result.removed].sort()).toEqual(["build-agent.md", "docs-canvas", "sentry-debug-issue", "sentry-get-started", "wrangler"]);
    expect(readlinkSync(join(cursorDir, "skills", "sentry-debug-issue"))).toBe(join(pluginRoot("579", "sha2"), "skills", "sentry-debug-issue"));
  });
});
