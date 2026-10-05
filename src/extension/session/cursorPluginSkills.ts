/**
 * Cursor plugin skills and commands.
 *
 * Cursor's terminal app loads the skills and commands that come with
 * installed Cursor plugins; ACP mode does not. It does list every folder in
 * `<cursor dir>/skills` (a symlink included; the command is the folder name,
 * not the SKILL.md `name`) and every `<cursor dir>/commands/*.md`. So each
 * plugin skill is linked into `skills/` (Windows: a directory junction) and
 * each plugin command into `commands/` (not on Windows, where file links need
 * extra rights).
 *
 * Plugins are read from the Cursor folder that holds them (it may be shared
 * through the `cursorAcp.mcpUserConfig` setting); links always go into the
 * agent's own `<agent HOME>/.cursor`. A skills or commands folder that is
 * itself a link, or that sits in a git repository, is shared with something
 * else and is never written to.
 *
 * Ownership: an entry is the extension's iff it is a link whose target lies
 * inside a known plugins folder. Real folders and files, and links anywhere
 * else, are the user's and are never touched; a plugin skill whose name is
 * taken by one of them is skipped and reported.
 *
 * No `vscode` import: unit tested against fixture folders.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { installedPlugins, type PluginRoot } from "./cursorPlugins";

export type PluginSkillKind = "skill" | "command";

export interface PluginSkill {
  readonly kind: PluginSkillKind;
  /** The slash command: the skill's folder name, or the command file name without `.md`. */
  readonly name: string;
  readonly pluginName: string;
  /** Absolute path of the skill folder or the command file inside the plugin. */
  readonly source: string;
  /** From the SKILL.md or command frontmatter. */
  readonly description?: string;
}

export interface PluginSkillDiscovery {
  readonly pluginsDir: string;
  readonly skills: ReadonlyArray<PluginSkill>;
  readonly errors: ReadonlyArray<string>;
  /** Whether the list of installed plugins could be read (so a missing skill really was uninstalled). */
  readonly complete: boolean;
}

function isInsideDir(child: string, parent: string, path: typeof posix): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** `description` from a YAML frontmatter block (single line, quoted, or folded), without a YAML parser. */
export function frontmatterDescription(text: string): string | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const lines = match[1]!.split(/\r?\n/);
  const index = lines.findIndex((l) => /^description\s*:/.test(l));
  if (index < 0) return undefined;
  let value = lines[index]!.replace(/^description\s*:\s*/, "").trim();
  if (/^[>|][-+]?$/.test(value) || value === "") {
    const block: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+\S/.test(line) && line.trim() !== "") break;
      block.push(line.trim());
    }
    value = block.join(" ").trim();
  } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.replace(/\s+/g, " ").trim() || undefined;
}

function readDescription(file: string): string | undefined {
  try {
    return frontmatterDescription(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** A declared path inside the plugin folder; paths may carry the plugin's folder in its repository (`gitPath`) as a prefix. */
function resolveDeclared(plugin: PluginRoot, declared: string): string | undefined {
  const clean = declared.replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = [clean];
  if (plugin.gitPath) {
    const prefix = `${plugin.gitPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")}/`;
    if (clean.startsWith(prefix)) candidates.push(clean.slice(prefix.length));
  }
  for (const candidate of candidates) {
    const full = resolve(plugin.root, candidate);
    if (relative(plugin.root, full).startsWith("..")) continue;
    if (existsSync(full)) return full;
  }
  return undefined;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Skill folders and command files of one plugin: the declared paths, or `skills/<name>/SKILL.md` and `commands/*.md`. */
function pluginEntries(plugin: PluginRoot, errors: string[]): PluginSkill[] {
  const found: PluginSkill[] = [];
  const add = (kind: PluginSkillKind, file: string) => {
    const source = kind === "skill" ? dirname(file) : file;
    const name = kind === "skill" ? basename(source) : basename(file).replace(/\.md$/i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      errors.push(`${plugin.name}: skipped ${kind} "${name}" (unusual name)`);
      return;
    }
    const description = readDescription(file);
    found.push({ kind, name, pluginName: plugin.name, source, ...(description ? { description } : {}) });
  };
  if (plugin.declared) {
    for (const path of plugin.declared.skill) {
      const file = resolveDeclared(plugin, path);
      if (file && basename(file) === "SKILL.md") add("skill", file);
      else errors.push(`${plugin.name}: skill ${path} not found`);
    }
    for (const path of plugin.declared.command) {
      const file = resolveDeclared(plugin, path);
      if (file && /\.md$/i.test(file)) add("command", file);
      else errors.push(`${plugin.name}: command ${path} not found`);
    }
    return found;
  }
  for (const folder of listDir(join(plugin.root, "skills"))) {
    const file = join(plugin.root, "skills", folder, "SKILL.md");
    if (existsSync(file)) add("skill", file);
  }
  for (const file of listDir(join(plugin.root, "commands"))) if (/\.md$/i.test(file)) add("command", join(plugin.root, "commands", file));
  return found;
}

/** Every skill and command of the plugins installed under `<cursorDir>/plugins`, sorted by plugin, then name. Never throws. */
export function discoverPluginSkills(cursorDir: string): PluginSkillDiscovery {
  const { pluginsDir, plugins, errors, complete } = installedPlugins(cursorDir);
  const skills = plugins.flatMap((p) => pluginEntries(p, errors));
  skills.sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { pluginsDir, skills, errors, complete };
}

// ---------------------------------------------------------------------------
// What is in skills/ and commands/ now
// ---------------------------------------------------------------------------

/** One entry of `skills/` or `commands/`: a link into the plugins folder (ours), or anything else (the user's). */
export type LinkEntry = { readonly managed: true; readonly target: string } | { readonly managed: false };

/**
 * Whether a link target lies inside one of the plugins folders. Windows
 * junctions read back as absolute paths, sometimes with a `\\?\` prefix and
 * in another case; `windows` switches to Windows path rules.
 */
export function isPluginTarget(target: string, pluginsDirs: ReadonlyArray<string>, windows = process.platform === "win32"): boolean {
  const path = windows ? win32 : posix;
  const clean = (p: string) => {
    let out = windows ? p.replace(/^\\\\\?\\/, "").replace(/^\\\?\?\\/, "") : p;
    out = path.normalize(out).replace(/[\\/]+$/, "");
    return windows ? out.toLowerCase() : out;
  };
  const t = clean(target);
  return pluginsDirs.some((dir) => isInsideDir(t, clean(dir), path));
}

/** The plugins folder as written and as resolved (the Cursor folder is often itself a link). */
export function pluginsDirVariants(cursorDir: string): string[] {
  const dir = join(cursorDir, "plugins");
  const out = [dir];
  try {
    const real = realpathSync(dir);
    if (real !== dir) out.push(real);
  } catch {
    // No plugins folder.
  }
  return out;
}

/** Reads a `skills/` or `commands/` folder: entry name to ownership. Command names drop `.md`. */
export function readLinkEntries(dir: string, kind: PluginSkillKind, pluginsDirs: ReadonlyArray<string>, windows = process.platform === "win32"): Map<string, LinkEntry> {
  const out = new Map<string, LinkEntry>();
  for (const entry of listDir(dir)) {
    if (kind === "command" && !/\.md$/i.test(entry)) continue;
    const name = kind === "command" ? entry.replace(/\.md$/i, "") : entry;
    const full = join(dir, entry);
    let state: LinkEntry = { managed: false };
    try {
      if (lstatSync(full).isSymbolicLink()) {
        const raw = readlinkSync(full);
        const target = windows ? win32.resolve(dir, raw) : resolve(dir, raw);
        if (isPluginTarget(target, pluginsDirs, windows)) state = { managed: true, target };
      }
    } catch {
      // Unreadable: treat as the user's.
    }
    out.set(name, state);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What to change
// ---------------------------------------------------------------------------

export type SkillState = "linked" | "missing" | "clash" | "off";

/**
 * Why a skills or commands folder must not be written to, or undefined when
 * it is the agent's own: it is a link (the whole folder shared), or it lies in
 * a git repository (the folder or its parent has `.git`, unless the parent is
 * the agent's Cursor folder itself). A missing folder is fine: it is created.
 */
export function sharedFolderReason(dir: string, agentCursorDir: string): string | undefined {
  try {
    if (lstatSync(dir).isSymbolicLink()) return `${dir} is a link to a shared folder`;
  } catch {
    return undefined;
  }
  try {
    const real = realpathSync(dir);
    if (real !== join(realpathSync(dirname(dir)), basename(dir))) return `${dir} is a link to a shared folder`;
    if (existsSync(join(real, ".git"))) return `${dir} is a git repository`;
    let cursorReal = agentCursorDir;
    try {
      cursorReal = realpathSync(agentCursorDir);
    } catch {
      // Not there yet.
    }
    if (dirname(real) !== cursorReal && existsSync(join(dirname(real), ".git"))) return `${dir} is inside a git repository`;
  } catch {
    return `${dir} could not be checked`;
  }
  return undefined;
}

export interface SkillPlanEntry {
  readonly skill: PluginSkill;
  /** linked: in place; missing: will be linked; clash: the name is taken; off: switched off. */
  readonly state: SkillState;
}

export interface SkillSyncPlan {
  readonly entries: ReadonlyArray<SkillPlanEntry>;
  readonly add: ReadonlyArray<PluginSkill>;
  /** Managed links to delete, by kind and name (a replaced link is removed, then added). */
  readonly remove: ReadonlyArray<{ readonly kind: PluginSkillKind; readonly name: string }>;
}

export interface SkillPlanInput {
  readonly discovery: Pick<PluginSkillDiscovery, "skills" | "complete">;
  readonly skills: ReadonlyMap<string, LinkEntry>;
  readonly commands: ReadonlyMap<string, LinkEntry>;
  /** Plugin names, or `plugin/name` for a single skill or command. */
  readonly exclude: ReadonlyArray<string>;
  /** The whole feature switch: off removes every managed link. */
  readonly enabled: boolean;
  /** Commands are not linked on Windows (file links need extra rights there). */
  readonly commandsSupported?: boolean;
  /** Folders that must not be written to (shared): their kind is left alone entirely. */
  readonly blocked?: { readonly skill?: boolean; readonly command?: boolean };
  readonly targetExists?: (path: string) => boolean;
  readonly windows?: boolean;
}

export function isExcluded(skill: Pick<PluginSkill, "pluginName" | "name">, exclude: ReadonlyArray<string>): boolean {
  return exclude.includes(skill.pluginName) || exclude.includes(`${skill.pluginName}/${skill.name}`);
}

function sameTarget(a: string, b: string, windows: boolean): boolean {
  const norm = (p: string) => (windows ? win32.normalize(p.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "").toLowerCase() : posix.normalize(p).replace(/\/+$/, ""));
  return norm(a) === norm(b);
}

/**
 * Links every plugin skill and command that is not excluded and whose name is
 * free; replaces links whose plugin moved to a new version; removes managed
 * links that are switched off, or whose plugin or skill is gone.
 */
export function planSkillSync(input: SkillPlanInput): SkillSyncPlan {
  const windows = input.windows ?? process.platform === "win32";
  const targetExists = input.targetExists ?? existsSync;
  const commandsSupported = input.commandsSupported ?? !windows;
  const entries: SkillPlanEntry[] = [];
  const add: PluginSkill[] = [];
  const remove: { kind: PluginSkillKind; name: string }[] = [];
  const kept = { skill: new Set<string>(), command: new Set<string>() };
  const claimed = { skill: new Set<string>(), command: new Set<string>() };
  for (const skill of input.discovery.skills) {
    if (skill.kind === "command" && !commandsSupported) continue;
    if (!input.enabled || isExcluded(skill, input.exclude) || input.blocked?.[skill.kind]) {
      entries.push({ skill, state: "off" });
      continue;
    }
    const existing = (skill.kind === "skill" ? input.skills : input.commands).get(skill.name);
    if (claimed[skill.kind].has(skill.name) || (existing && !existing.managed)) {
      entries.push({ skill, state: "clash" });
      continue;
    }
    claimed[skill.kind].add(skill.name);
    kept[skill.kind].add(skill.name);
    if (existing?.managed && sameTarget(existing.target, skill.source, windows)) {
      entries.push({ skill, state: "linked" });
      continue;
    }
    if (existing?.managed) remove.push({ kind: skill.kind, name: skill.name });
    add.push(skill);
    entries.push({ skill, state: "missing" });
  }
  const known = { skill: new Set<string>(), command: new Set<string>() };
  for (const s of input.discovery.skills) known[s.kind].add(s.name);
  for (const kind of ["skill", "command"] as const) {
    if (input.blocked?.[kind]) continue;
    for (const [name, entry] of kind === "skill" ? input.skills : input.commands) {
      if (!entry.managed || kept[kind].has(name)) continue;
      // Keep links of plugins that are listed but not downloaded yet, unless they are broken.
      const gone = input.discovery.complete || known[kind].has(name) || !targetExists(entry.target);
      if (!input.enabled || gone) remove.push({ kind, name });
    }
  }
  return { entries, add, remove };
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

export interface SkillSyncResult {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly changed: boolean;
  readonly errors: ReadonlyArray<string>;
}

export function skillsDir(cursorDir: string): string {
  return join(cursorDir, "skills");
}

export function commandsDir(cursorDir: string): string {
  return join(cursorDir, "commands");
}

export interface SkillTarget {
  /** The agent's own Cursor folder (`<agent HOME>/.cursor`): links go into its `skills/` and `commands/`. */
  readonly linkDir: string;
  /** Every plugins folder a link of ours may point into (the discovery one and the agent's own). */
  readonly pluginsDirs: ReadonlyArray<string>;
}

export function skillTarget(linkDir: string, pluginsCursorDirs: ReadonlyArray<string>): SkillTarget {
  return { linkDir, pluginsDirs: [...new Set(pluginsCursorDirs.flatMap(pluginsDirVariants))] };
}

export interface CurrentSkillPlan extends SkillSyncPlan {
  /** Why nothing is written to the skills or commands folder, when it is shared. */
  readonly shared: { readonly skill?: string; readonly command?: string };
}

/** Reads both folders and plans against them; shared folders are left out. */
export function currentSkillPlan(target: SkillTarget, discovery: PluginSkillDiscovery, exclude: ReadonlyArray<string>, enabled: boolean, windows = process.platform === "win32"): CurrentSkillPlan {
  const skillReason = sharedFolderReason(skillsDir(target.linkDir), target.linkDir);
  const commandReason = sharedFolderReason(commandsDir(target.linkDir), target.linkDir);
  const plan = planSkillSync({
    discovery,
    skills: skillReason ? new Map() : readLinkEntries(skillsDir(target.linkDir), "skill", target.pluginsDirs, windows),
    commands: commandReason ? new Map() : readLinkEntries(commandsDir(target.linkDir), "command", target.pluginsDirs, windows),
    exclude,
    enabled,
    windows,
    blocked: { skill: !!skillReason, command: !!commandReason },
  });
  return { ...plan, shared: { ...(skillReason ? { skill: skillReason } : {}), ...(commandReason ? { command: commandReason } : {}) } };
}

/** Removes and creates the links of a plan. Each failure is reported and the rest carries on. */
export function applySkillPlan(target: SkillTarget, plan: SkillSyncPlan, windows = process.platform === "win32"): SkillSyncResult {
  const cursorDir = target.linkDir;
  const added: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];
  const pathOf = (kind: PluginSkillKind, name: string) => (kind === "skill" ? join(skillsDir(cursorDir), name) : join(commandsDir(cursorDir), `${name}.md`));
  const dirs = target.pluginsDirs;
  for (const { kind, name } of plan.remove) {
    const path = pathOf(kind, name);
    try {
      // Re-check ownership right before deleting.
      if (!lstatSync(path).isSymbolicLink() || !isPluginTarget((windows ? win32.resolve : resolve)(dirname(path), readlinkSync(path)), dirs, windows)) continue;
      unlinkSync(path);
      removed.push(kind === "skill" ? name : `${name}.md`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const skill of plan.add) {
    const path = pathOf(skill.kind, skill.name);
    try {
      mkdirSync(dirname(path), { recursive: true });
      // Re-check right before writing: never into a shared folder.
      const reason = sharedFolderReason(dirname(path), cursorDir);
      if (reason) throw new Error(reason);
      if (skill.kind === "skill" && !statSync(skill.source).isDirectory()) throw new Error("not a folder");
      symlinkSync(skill.source, path, skill.kind === "skill" ? (windows ? "junction" : "dir") : "file");
      added.push(skill.kind === "skill" ? skill.name : `${skill.name}.md`);
    } catch (error) {
      errors.push(`Could not link ${skill.pluginName} ${skill.kind} ${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { added, removed, changed: added.length > 0 || removed.length > 0, errors };
}
