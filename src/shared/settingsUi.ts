/**
 * Pure helpers behind the settings editor tab: section ids (shared by the
 * host command and the webview), agent-argument parsing and the safe-list
 * row editor's parse / serialise rules.
 */

export const SETTINGS_SECTIONS = ["general", "agent", "approvals", "models", "mcp", "advanced"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = "general";

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as ReadonlyArray<string>).includes(value);
}

/** Accepts anything (command arguments, persisted state, older tab names) and returns a valid section id or `undefined`. */
export function parseSettingsSection(value: unknown): SettingsSection | undefined {
  if (isSettingsSection(value)) return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (isSettingsSection(lower)) return lower;
    // Names of the old in-sidebar settings tabs.
    if (lower === "behaviour" || lower === "behavior") return "general";
    if (lower === "mcpservers" || lower === "mcp servers" || lower === "mcp-servers") return "mcp";
    return undefined;
  }
  if (value && typeof value === "object" && "section" in value) return parseSettingsSection((value as { section: unknown }).section);
  return undefined;
}

/** Split a command line on whitespace, honouring simple single/double quotes. */
export function parseArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const token = m[1] ?? m[2] ?? m[3] ?? "";
    if (token.length) out.push(token);
  }
  return out;
}

export function joinArgs(args: ReadonlyArray<string>): string {
  return args.map((a) => (/\s|"/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a === "" ? '""' : a)).join(" ");
}

export function sameArray(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Whether an `agent mcp list` status means the server waits for approval in Cursor's terminal app. */
export function mcpNeedsApproval(server: { readonly status: string }): boolean {
  return /needs approval|not approved|unapproved/i.test(server.status);
}

// ---------------------------------------------------------------------------
// Safe list rows
// ---------------------------------------------------------------------------

/** Why a safe-list pattern cannot be used, or `undefined` when it compiles (empty rows are fine; they are dropped). */
export function safePatternError(pattern: string): string | undefined {
  if (!pattern.trim()) return undefined;
  try {
    new RegExp(pattern.trim());
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "Invalid regular expression: /(/: Unterminated group" -> "Unterminated group"
    return message.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "");
  }
}

/**
 * Rows being edited -> the stored list: surrounding whitespace is dropped
 * (the matcher would otherwise require it), empty rows vanish, and exact
 * duplicates keep their first position.
 */
export function safeListFromRows(rows: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const pattern = row.trim();
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/** Stored list (possibly hand-edited JSON) -> editable rows; non-strings are ignored. */
export function safeListToRows(list: ReadonlyArray<unknown> | undefined): string[] {
  return (list ?? []).filter((x): x is string => typeof x === "string");
}

/** Pasting several lines into one row splits them into separate patterns. */
export function splitPastedPatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
