/**
 * Client-side approval policy for Cursor's `session/request_permission`.
 *
 * Cursor only offers allow-once / allow-always / reject, and "always" writes
 * to the CLI's global config for the account. Everything here stays inside
 * the extension and the current session:
 *
 *  - `auto`: answer every request with allow-once.
 *  - `safe`: allow-once when the request matches the safe list; ask otherwise.
 *  - `ask`:  ask for everything.
 *
 * On top of the policy, "Allow for session" remembers a command name (or a
 * Cursor permission pattern such as `Mcp(server:tool)`) for the rest of the
 * session.
 */

export type ApprovalPolicy = "ask" | "safe" | "auto";

export const APPROVAL_POLICIES: ReadonlyArray<{ id: ApprovalPolicy; name: string; description: string }> = [
  { id: "ask", name: "Ask", description: "Prompt for every command and tool call." },
  { id: "safe", name: "Safe list", description: "Run read-only commands and tools from the safe list without asking; prompt for the rest." },
  { id: "auto", name: "Auto", description: "Run everything without asking, for this session only." },
];

/**
 * Default safe list. Each entry is a regular expression tested against one
 * shell segment (the parts of a command line between `|`, `&&`, `||`, `;`),
 * or against a Cursor permission pattern like `Mcp(server:tool)`.
 */
export const DEFAULT_SAFE_LIST: ReadonlyArray<string> = [
  // Looking at files and the environment.
  "^(cd|ls|pwd|whoami|id|date|uname|hostname|which|type|command -v|echo|printf|cat|head|tail|less|more|wc|file|stat|du|df|tree|realpath|dirname|basename|true|false)\\b",
  "^(grep|egrep|fgrep|rg|ag|find|fd|locate)\\b",
  "^(sort|uniq|cut|tr|column|jq|yq|diff|comm|nl|tac|rev|sed -n)\\b",
  // Read-only git.
  "^git (status|diff|log|show|branch|remote|rev-parse|blame|ls-files|ls-remote|describe|tag|stash list|shortlog|reflog|cat-file|config --get|worktree list)\\b",
  // Version checks.
  "^(node|npm|npx|pnpm|yarn|bun|deno|python3?|pip3?|ruby|gem|go|cargo|rustc|java|javac|dotnet|php|composer|swift|docker|kubectl|terraform|aws|gcloud|az|gh|code|cursor|agent) (-v|--version|-V|version)$",
  // Package managers, read-only subcommands.
  "^(npm|pnpm|yarn) (ls|list|view|info|outdated|why|audit)\\b",
  // GitHub CLI, read-only subcommands.
  "^gh (pr|issue|repo|run|release|workflow|search) (view|list|status|checks|diff|code|prs|issues)\\b",
  // Containers and clusters, read-only.
  "^docker (ps|images|logs|inspect|version|info)\\b",
  "^kubectl (get|describe|logs|version)\\b",
  // Atlassian CLI, read-only.
  "^acli \\S+ \\S+ (search|view|list|get)\\b",
  // MCP tools whose names read as lookups, e.g. Mcp(plugin-atlassian-atlassian:searchJiraIssuesUsingJql).
  "^Mcp\\([^)]*:(get|list|search|read|fetch|find|query|describe|lookup|discover|view)[A-Za-z0-9_]*\\)$",
];

export interface CompiledSafeList {
  readonly patterns: ReadonlyArray<RegExp>;
  readonly invalid: ReadonlyArray<string>;
}

export function compileSafeList(entries: ReadonlyArray<string>): CompiledSafeList {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    try {
      patterns.push(new RegExp(entry));
    } catch {
      invalid.push(entry);
    }
  }
  return { patterns, invalid };
}

/** What a permission request is about, in the forms the safe list and session allow-list match on. */
export interface PermissionSubject {
  /** Shell command line, when the request is for a command. */
  readonly command?: string;
  /** Cursor's own permission pattern from the reason text, e.g. `Shell(npm)` or `Mcp(server:tool)`. */
  readonly pattern?: string;
  readonly title: string;
}

const PATTERN_RE = /\b([A-Z][A-Za-z]+)\(([^()]+)\)/;

export function subjectFrom(input: { command?: string; title: string; reason?: string; pattern?: string }): PermissionSubject {
  const pattern = input.pattern ?? (input.reason ? PATTERN_RE.exec(input.reason)?.[0] : undefined);
  return { ...(input.command ? { command: input.command } : {}), ...(pattern ? { pattern } : {}), title: input.title };
}

/** An MCP tool call's server id (Cursor's `providerIdentifier`) and tool name. */
export interface McpTool {
  readonly server: string;
  readonly tool: string;
}

/**
 * The MCP server and tool behind a tool call, from the call's raw input
 * (`providerIdentifier` / `toolName`) or, failing that, from the title Cursor
 * gives it: `<server>-<tool>: <tool>` (or `<server>: <tool>`). The generic
 * first title, `MCP: tool`, names neither.
 */
export function mcpToolFrom(rawInput: unknown, title: string | undefined): McpTool | undefined {
  if (typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)) {
    const r = rawInput as Record<string, unknown>;
    if (typeof r.providerIdentifier === "string" && r.providerIdentifier && typeof r.toolName === "string" && r.toolName) return { server: r.providerIdentifier, tool: r.toolName };
  }
  if (!title) return undefined;
  const joined = /^(\S+)-(\S+): \2$/.exec(title.trim());
  if (joined) return { server: joined[1]!, tool: joined[2]! };
  const plain = /^([A-Za-z0-9_.-]+): ([A-Za-z0-9_.-]+)$/.exec(title.trim());
  if (plain && plain[1] !== "MCP") return { server: plain[1]!, tool: plain[2]! };
  return undefined;
}

/**
 * Cursor's `Mcp(server:tool)` pattern for an MCP tool call. Permission
 * requests for MCP tools carry no reason text (their content is the tool's
 * arguments), so the pattern is rebuilt from the call (see mcpToolFrom).
 */
export function mcpPatternFrom(rawInput: unknown, title: string | undefined): string | undefined {
  const mcp = mcpToolFrom(rawInput, title);
  return mcp ? `Mcp(${mcp.server}:${mcp.tool})` : undefined;
}

/** The server and tool of an `Mcp(server:tool)` pattern. */
export function mcpToolFromPattern(pattern: string | undefined): McpTool | undefined {
  const match = pattern ? /^Mcp\(([^:()]+):([^()]+)\)$/.exec(pattern) : null;
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

/** Key under which "Allow for session" remembers a subject: the command name, else Cursor's pattern, else the title. */
export function sessionKey(subject: PermissionSubject): string {
  if (subject.command) return commandName(subject.command);
  return subject.pattern ?? subject.title;
}

/** First word of a command, ignoring leading env assignments, `sudo`, and a directory prefix. */
export function commandName(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i++;
  if (words[i] === "sudo" || words[i] === "command" || words[i] === "exec") i++;
  const word = words[i] ?? "";
  return word.replace(/^.*\//, "");
}

/**
 * Splits a command line into the segments joined by `|`, `||`, `&&`, `;` and
 * newlines, honouring quotes. Returns undefined when the line uses constructs
 * the safe list must not vouch for: output redirection (other than to /dev/null
 * or another fd), command substitution, process substitution, `eval`, or an
 * inline shell (`sh -c`).
 */
export function splitShellSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  const text = command.replace(/\r\n?/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        current += text[++i];
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      current += ch + text[++i];
      continue;
    }
    if (ch === "`" || (ch === "$" && text[i + 1] === "(") || ((ch === "<" || ch === ">") && text[i + 1] === "(")) return undefined;
    if (ch === ">") {
      // `2>&1` and `>/dev/null` do not write anywhere interesting; anything else is a write.
      const rest = text.slice(i + 1);
      if (/^>?\s*&\d/.test(rest) || /^>?\s*\/dev\/null\b/.test(rest)) {
        const m = /^(>?\s*&\d|>?\s*\/dev\/null)/.exec(rest)!;
        current += ch + m[0];
        i += m[0].length;
        continue;
      }
      return undefined;
    }
    if (ch === "<" ) {
      // Input redirection from a file is read-only.
      current += ch;
      continue;
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
      if ((ch === "|" || ch === "&") && text[i + 1] === ch) i++;
      else if (ch === "&") continue; // trailing `&` (background): treat as separator too
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) return undefined; // unbalanced quotes: don't guess
  segments.push(current);
  const cleaned = segments.map((s) => s.trim()).filter(Boolean);
  for (const seg of cleaned) {
    const name = commandName(seg);
    if (name === "eval" || name === "source" || name === "." || /^(sh|bash|zsh|fish|dash|ksh|pwsh|powershell|cmd)$/.test(name)) return undefined;
  }
  return cleaned;
}

/** True when the safe list vouches for every part of the request. */
export function isSafe(subject: PermissionSubject, list: CompiledSafeList): boolean {
  if (list.patterns.length === 0) return false;
  const matches = (s: string) => list.patterns.some((p) => p.test(s));
  if (subject.command) {
    const segments = splitShellSegments(subject.command);
    if (!segments || segments.length === 0) return false;
    return segments.every(matches);
  }
  if (subject.pattern && matches(subject.pattern)) return true;
  return matches(subject.title);
}
