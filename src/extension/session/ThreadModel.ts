/**
 * ThreadModel turns raw ACP session updates into the transcript the webview
 * renders. It is pure (no VS Code / process dependencies) so it can be unit
 * tested, and it emits fine-grained deltas so streaming stays smooth.
 *
 * Grouping rules (what makes the transcript readable):
 *  - consecutive agent_message_chunk → one assistant block
 *  - consecutive agent_thought_chunk → one thought block
 *  - a tool call / plan / question closes the open text blocks, so the next
 *    chunk starts a fresh block after the tool card
 *  - items created while `replay` is on are flagged and never "streaming"
 */
import type * as acp from "@agentclientprotocol/sdk";
import { isAbsolute, relative, sep } from "node:path";
import type {
  ExtensionToWebview,
  FileDiff,
  NoticeAction,
  PermissionOption,
  PermissionState,
  PlanEntry,
  PlanProposalItem,
  Question,
  QuestionAnswer,
  QuestionItem,
  StopReason,
  ThreadItem,
  TodoEntry,
  ToolItem,
  ToolKind,
  ToolLocation,
  ToolStatus,
  UserAttachment,
} from "../../shared/protocol";
import { buildFileDiff, normalizeCursorDiff } from "./diff";
import type { CursorTodo } from "../acp/AcpConnection";

export type ThreadSink = (message: ExtensionToWebview) => void;

const TOOL_OUTPUT_LIMIT = 200_000;
const TOOL_OUTPUT_TRUNCATION = "[earlier output truncated]\n";
/** Read-tool file contents and pretty-printed inputs are shown, not streamed; keep the head. */
const FILE_CONTENT_LIMIT = 200_000;
const INPUT_TEXT_LIMIT = 50_000;
const HEAD_TRUNCATION = "\n[… truncated]";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolStatus(status: unknown, fallback: ToolStatus): ToolStatus {
  switch (status) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
      return status;
    case "inProgress":
      return "in_progress";
    default:
      return fallback;
  }
}

function normalizeToolKind(kind: unknown): ToolKind {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "think":
    case "fetch":
    case "switch_mode":
      return kind;
    default:
      return "other";
  }
}

function normalizeTodoStatus(status: unknown): TodoEntry["status"] {
  switch (status) {
    case "completed":
    case "done":
      return "completed";
    case "in_progress":
    case "inProgress":
    case "in-progress":
      return "in_progress";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "pending";
  }
}

function normalizePlanStatus(status: unknown): PlanEntry["status"] {
  return normalizeTodoStatus(status);
}

function extractCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const command = rawInput.command;
    if (typeof command === "string" && command.trim()) return command.trim();
    if (Array.isArray(command)) {
      const parts = command.filter((part): part is string => typeof part === "string");
      if (parts.length > 0) return parts.join(" ");
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable : undefined;
    if (executable) {
      const args = Array.isArray(rawInput.args) ? rawInput.args.filter((a): a is string => typeof a === "string") : [];
      return [executable, ...args].join(" ");
    }
  }
  if (title) {
    const match = /^`([^`]+)`$/.exec(title.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

const SUBTITLE_KEYS = ["path", "file_path", "filePath", "target_file", "query", "pattern", "url", "glob", "directory", "dir"] as const;

function extractSubtitle(rawInput: unknown, toDisplayPath: (p: string) => string): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  for (const key of SUBTITLE_KEYS) {
    const value = rawInput[key];
    if (typeof value === "string" && value.trim()) {
      return key.toLowerCase().includes("path") || key === "target_file" || key === "directory" || key === "dir"
        ? toDisplayPath(value)
        : value;
    }
  }
  return undefined;
}

function prettyInput(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const keys = Object.keys(rawInput);
  if (keys.length === 0) return undefined;
  if (keys.length === 1 && (keys[0] === "command" || keys[0] === "path")) return undefined;
  try {
    return boundHead(JSON.stringify(rawInput, null, 2), INPUT_TEXT_LIMIT);
  } catch {
    return undefined;
  }
}

function boundOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text;
  return TOOL_OUTPUT_TRUNCATION + text.slice(text.length - TOOL_OUTPUT_LIMIT);
}

function boundHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + HEAD_TRUNCATION;
}

interface CachedDiff {
  readonly oldText: string | null | undefined;
  readonly newText: string;
  readonly diff: FileDiff;
}

interface ChangeTotals {
  displayPath: string;
  additions: number;
  deletions: number;
}

export function stripCursorTitleBackticks(title: string): string {
  const match = /^`([^`]+)`$/.exec(title.trim());
  return match?.[1] ?? title;
}

export class ThreadModel {
  private items: ThreadItem[] = [];
  private readonly index = new Map<string, number>();
  private readonly toolIndex = new Map<string, string>();
  private readonly toolRawInput = new Map<string, unknown>();
  /**
   * Last diff built per tool call and path. Cursor resends the full (identical)
   * diff content with every tool_call_update, so re-diffing is wasted work.
   */
  private readonly toolDiffs = new Map<string, Map<string, CachedDiff>>();
  private openAssistantId: string | undefined;
  private openThoughtId: string | undefined;
  private openUserId: string | undefined;
  private replay = false;
  private counter = 0;
  private turnStartedAt: number | undefined;
  /** Diffs of each finished tool item (keyed by item id); the changed-files summary is the sum of these. */
  private readonly changesByTool = new Map<string, ReadonlyArray<FileDiff>>();
  private changedCache: ReadonlyArray<{ path: string; displayPath: string; additions: number; deletions: number }> | undefined;
  private changedVersion = 0;

  /** Receives the full before/after text of every edit (for the native diff editor). */
  private onDiff: ((itemId: string, path: string, oldText: string, newText: string) => void) | undefined;

  constructor(
    private readonly sink: ThreadSink,
    private cwd: string,
  ) {}

  setDiffListener(listener: (itemId: string, path: string, oldText: string, newText: string) => void): void {
    this.onDiff = listener;
  }

  // --- accessors --------------------------------------------------------------

  getItems(): ReadonlyArray<ThreadItem> {
    return this.items;
  }

  get turnStart(): number | undefined {
    return this.turnStartedAt;
  }

  get isReplay(): boolean {
    return this.replay;
  }

  /** Aggregated per-file additions/deletions of finished edit tools. Memoised until the next change. */
  changedFiles(): ReadonlyArray<{ path: string; displayPath: string; additions: number; deletions: number }> {
    if (this.changedCache) return this.changedCache;
    const totals = new Map<string, ChangeTotals>();
    for (const diffs of this.changesByTool.values()) {
      for (const diff of diffs) {
        const prev = totals.get(diff.path);
        if (prev) {
          prev.additions += diff.additions;
          prev.deletions += diff.deletions;
        } else {
          totals.set(diff.path, { displayPath: diff.displayPath, additions: diff.additions, deletions: diff.deletions });
        }
      }
    }
    this.changedCache = Array.from(totals, ([path, value]) => ({ path, ...value }));
    return this.changedCache;
  }

  /** Bumps whenever `changedFiles()` would return something different. */
  get changedFilesVersion(): number {
    return this.changedVersion;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /** Cursor titles look like "Edit `/abs/path/file.ts`"; show workspace-relative paths without backticks. */
  private prettifyTitle(title: string): string {
    if (/^`[^`]+`$/.test(title)) return title; // a bare command title: keep as-is (rendered monospace)
    const withoutBackticks = title.replace(/`([^`]+)`/g, (match, inner: string) => (isAbsolute(inner) ? this.toDisplayPath(inner) : match));
    // Also shorten bare absolute paths inside the workspace ("Read /abs/ws/file.ts" → "Read file.ts").
    // The agent may report paths with either separator on Windows, so both forms are stripped.
    if (this.cwd) {
      const base = this.cwd.replace(/[\\/]+$/, "");
      const alt = base.includes("\\") ? base.split("\\").join("/") : base.split("/").join("\\");
      let out = withoutBackticks;
      for (const prefix of new Set([base + "/", base + "\\", alt + "/", alt + "\\"])) out = out.split(prefix).join("");
      return out;
    }
    return withoutBackticks;
  }

  toDisplayPath(path: string): string {
    if (!path) return path;
    if (isAbsolute(path) && this.cwd) {
      const rel = relative(this.cwd, path);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
    }
    return path;
  }

  // --- lifecycle --------------------------------------------------------------

  reset(): void {
    this.items = [];
    this.index.clear();
    this.toolIndex.clear();
    this.toolRawInput.clear();
    this.toolDiffs.clear();
    if (this.changesByTool.size > 0) {
      this.changesByTool.clear();
      this.changedCache = undefined;
      this.changedVersion += 1;
    }
    this.openAssistantId = this.openThoughtId = this.openUserId = undefined;
    this.turnStartedAt = undefined;
    this.sink({ type: "items.reset", items: [] });
  }

  setReplay(replay: boolean): void {
    if (this.replay === replay) return;
    this.closeSegments();
    this.replay = replay;
  }

  beginTurn(text: string, attachments: ReadonlyArray<UserAttachment>): void {
    this.closeSegments();
    this.turnStartedAt = Date.now();
    this.add({ type: "user", id: this.nextId("user"), text, attachments, createdAt: Date.now() });
  }

  endTurn(stopReason: StopReason): void {
    this.closeSegments();
    const startedAt = this.turnStartedAt;
    this.turnStartedAt = undefined;
    if (this.replay) return;
    this.add({
      type: "turn_end",
      id: this.nextId("turn"),
      stopReason,
      durationMs: startedAt ? Date.now() - startedAt : 0,
      createdAt: Date.now(),
    });
  }

  /** Marks streaming blocks as finished; the next chunk starts a new block. */
  closeSegments(): void {
    for (const id of [this.openAssistantId, this.openThoughtId]) {
      if (!id) continue;
      const item = this.get(id);
      if (item && (item.type === "assistant" || item.type === "thought") && item.streaming) {
        this.update({ ...item, streaming: false, ...(item.type === "thought" ? { endedAt: Date.now() } : {}) });
      }
    }
    this.openAssistantId = this.openThoughtId = this.openUserId = undefined;
  }

  addDivider(text: string): void {
    this.closeSegments();
    this.add({ type: "divider", id: this.nextId("divider"), text, createdAt: Date.now() });
  }

  addNotice(level: "info" | "warning" | "error", text: string, detail?: string, actions: ReadonlyArray<NoticeAction> = []): void {
    this.closeSegments();
    this.add({ type: "notice", id: this.nextId("notice"), level, text, ...(detail ? { detail } : {}), actions, createdAt: Date.now() });
  }

  // --- ACP session updates ------------------------------------------------------

  /**
   * Applies a `session/update`. Returns false for update kinds the model does
   * not own (mode / commands / config / session info), so the runtime can
   * handle them.
   */
  applyUpdate(update: acp.SessionUpdate): boolean {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendText("assistant", update.content);
        return true;
      case "agent_thought_chunk":
        this.appendText("thought", update.content);
        return true;
      case "user_message_chunk":
        this.appendUserChunk(update.content);
        return true;
      case "tool_call":
        this.upsertTool(update, "pending");
        return true;
      case "tool_call_update":
        this.upsertTool(update, "in_progress");
        return true;
      case "plan":
        this.setPlan(update.entries ?? []);
        return true;
      default:
        return false;
    }
  }

  private contentText(content: acp.ContentBlock): string {
    switch (content.type) {
      case "text":
        return content.text;
      case "resource_link":
        return content.uri;
      case "resource":
        return "text" in content.resource ? content.resource.text : "";
      case "image":
        return "";
      default:
        return "";
    }
  }

  private appendText(kind: "assistant" | "thought", content: acp.ContentBlock): void {
    const text = this.contentText(content);
    if (!text) return;
    const openId = kind === "assistant" ? this.openAssistantId : this.openThoughtId;
    if (openId) {
      const item = this.get(openId);
      if (item && item.type === kind) {
        this.replaceSilently({ ...item, text: item.text + text });
        this.sink({ type: "item.append", id: openId, field: "text", text });
        return;
      }
    }
    // Starting a new block closes the other open blocks (thought ↔ message).
    this.closeSegments();
    const id = this.nextId(kind);
    const now = Date.now();
    if (kind === "assistant") {
      this.openAssistantId = id;
      this.add({ type: "assistant", id, text, streaming: !this.replay, createdAt: now, ...(this.replay ? { replay: true } : {}) });
    } else {
      this.openThoughtId = id;
      this.add({ type: "thought", id, text, streaming: !this.replay, createdAt: now, ...(this.replay ? { replay: true, endedAt: now } : {}) });
    }
  }

  private appendUserChunk(content: acp.ContentBlock): void {
    const text = this.contentText(content);
    if (this.openUserId) {
      const item = this.get(this.openUserId);
      if (item && item.type === "user") {
        this.update({ ...item, text: item.text + text });
        return;
      }
    }
    this.closeSegments();
    const id = this.nextId("user");
    this.openUserId = id;
    const attachments: UserAttachment[] = [];
    if (content.type === "image") {
      attachments.push({ kind: "image", label: "image", previewDataUrl: `data:${content.mimeType};base64,${content.data}` });
    }
    this.add({ type: "user", id, text, attachments, createdAt: Date.now(), ...(this.replay ? { replay: true } : {}) });
  }

  private upsertTool(update: acp.ToolCall | acp.ToolCallUpdate, fallbackStatus: ToolStatus): void {
    // A tool card interrupts the text flow; subsequent chunks start new blocks.
    this.closeSegments();
    const existingId = this.toolIndex.get(update.toolCallId);
    const existing = existingId ? this.get(existingId) : undefined;
    const base: ToolItem =
      existing && existing.type === "tool"
        ? existing
        : {
            type: "tool",
            id: this.nextId("tool"),
            toolCallId: update.toolCallId,
            kind: "other",
            title: "Tool",
            status: fallbackStatus,
            output: "",
            diffs: [],
            locations: [],
            createdAt: Date.now(),
            ...(this.replay ? { replay: true } : {}),
          };

    const rawInput = update.rawInput !== undefined && update.rawInput !== null ? update.rawInput : this.toolRawInput.get(update.toolCallId);
    if (rawInput !== undefined) this.toolRawInput.set(update.toolCallId, rawInput);
    const title = typeof update.title === "string" && update.title.trim() ? this.prettifyTitle(update.title.trim()) : base.title;
    const kind = update.kind ? normalizeToolKind(update.kind) : base.kind;
    const status = update.status !== undefined && update.status !== null ? normalizeToolStatus(update.status, base.status) : base.status;
    const command = extractCommand(rawInput, title) ?? base.command;
    const rawSubtitle = extractSubtitle(rawInput, (p) => this.toDisplayPath(p)) ?? base.subtitle;
    // Drop the subtitle when the title already names the same path (Cursor titles edits/reads by path).
    const subtitle = rawSubtitle && title.includes(rawSubtitle) ? undefined : rawSubtitle;
    const inputText = prettyInput(rawInput) ?? base.inputText;

    let output = base.output;
    let fileContent = base.fileContent;
    let exitCode = base.exitCode;
    let diffs: FileDiff[] = [...base.diffs];
    let locations: ToolLocation[] = [...base.locations];

    if (update.content) {
      // `content` replaces the tool's content list; rebuild text + diffs from it.
      const texts: string[] = [];
      const nextDiffs: FileDiff[] = [];
      for (const entry of update.content) {
        if (entry.type === "content") {
          const t = this.contentText(entry.content);
          if (t.trim()) texts.push(t);
        } else if (entry.type === "diff") {
          nextDiffs.push(this.diffFor(update.toolCallId, base.id, entry));
        } else if (entry.type === "terminal") {
          texts.push(`[terminal ${entry.terminalId}]`);
        }
      }
      if (texts.length > 0) output = texts.join("\n");
      if (nextDiffs.length > 0) diffs = nextDiffs;
    }
    if (update.rawOutput !== undefined && update.rawOutput !== null) {
      const raw = update.rawOutput;
      if (isRecord(raw)) {
        const parts: string[] = [];
        if (typeof raw.stdout === "string" && raw.stdout.length > 0) parts.push(raw.stdout);
        if (typeof raw.stderr === "string" && raw.stderr.length > 0) parts.push(raw.stderr);
        if (typeof raw.output === "string" && raw.output.length > 0) parts.push(raw.output);
        if (typeof raw.exitCode === "number") exitCode = raw.exitCode;
        if (typeof raw.content === "string" && (kind === "read" || parts.length === 0)) {
          if (kind === "read") fileContent = boundHead(raw.content, FILE_CONTENT_LIMIT);
          else parts.push(raw.content);
        }
        if (typeof raw.error === "string" && raw.error) parts.push(raw.error);
        if (parts.length > 0) output = parts.join("\n");
        else if (!output && kind !== "read" && kind !== "edit") {
          try {
            output = JSON.stringify(raw, null, 2);
          } catch {
            // ignore
          }
        }
      } else if (typeof raw === "string") {
        output = raw;
      }
    }
    if (update.locations) {
      locations = update.locations.map((loc) => ({
        path: loc.path,
        displayPath: this.toDisplayPath(loc.path),
        ...(typeof loc.line === "number" ? { line: loc.line } : {}),
      }));
    }
    const finished = status === "completed" || status === "failed";
    const next: ToolItem = {
      ...base,
      toolCallId: update.toolCallId,
      kind,
      title,
      status,
      ...(command ? { command } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(inputText ? { inputText } : {}),
      output: boundOutput(output),
      ...(exitCode !== undefined ? { exitCode } : {}),
      diffs,
      locations,
      ...(fileContent !== undefined ? { fileContent } : {}),
      ...(finished && !base.endedAt ? { endedAt: Date.now() } : {}),
    };
    if (existing && existing.type === "tool") {
      this.update(next);
    } else {
      this.toolIndex.set(update.toolCallId, next.id);
      this.add(next);
    }
    if (finished && diffs.length > 0) this.recordChanges(next.id, diffs);
  }

  /** Builds (or reuses) the display diff for one `diff` content entry and forwards the full texts once. */
  private diffFor(toolCallId: string, itemId: string, entry: { path: string; oldText?: string | null; newText: string }): FileDiff {
    let byPath = this.toolDiffs.get(toolCallId);
    const cached = byPath?.get(entry.path);
    if (cached && cached.oldText === entry.oldText && cached.newText === entry.newText) return cached.diff;
    const raw = { path: entry.path, oldText: entry.oldText, newText: entry.newText };
    const diff = buildFileDiff(raw, this.toDisplayPath(entry.path));
    if (!byPath) {
      byPath = new Map();
      this.toolDiffs.set(toolCallId, byPath);
    }
    byPath.set(entry.path, { oldText: entry.oldText, newText: entry.newText, diff });
    if (this.onDiff) {
      const normalized = normalizeCursorDiff(raw);
      this.onDiff(itemId, entry.path, normalized.oldText, normalized.newText);
    }
    return diff;
  }

  /** Replaces the changed-files contribution of a finished tool (idempotent for repeated updates). */
  private recordChanges(itemId: string, diffs: ReadonlyArray<FileDiff>): void {
    const previous = this.changesByTool.get(itemId);
    if (previous === diffs) return;
    if (previous && previous.length === diffs.length && previous.every((d, i) => d === diffs[i])) return;
    this.changesByTool.set(itemId, diffs);
    this.changedCache = undefined;
    this.changedVersion += 1;
  }

  private setPlan(entries: ReadonlyArray<acp.PlanEntry>): void {
    const mapped: PlanEntry[] = entries.map((entry) => ({
      content: entry.content,
      status: normalizePlanStatus(entry.status),
      ...(entry.priority ? { priority: entry.priority } : {}),
    }));
    const existing = this.findLast((item): item is Extract<ThreadItem, { type: "plan" }> => item.type === "plan", this.lastUserIndex());
    if (existing) {
      this.update({ ...existing, entries: mapped });
      return;
    }
    this.closeSegments();
    this.add({ type: "plan", id: this.nextId("plan"), entries: mapped, createdAt: Date.now(), ...(this.replay ? { replay: true } : {}) });
  }

  // --- Cursor extensions --------------------------------------------------------

  setTodos(todos: ReadonlyArray<CursorTodo>, merge: boolean): void {
    const mapped: TodoEntry[] = todos.flatMap((todo, i) => {
      const content = (todo.content ?? todo.title ?? "").trim();
      if (!content) return [];
      return [{ id: todo.id ?? `todo-${i}`, content, status: normalizeTodoStatus(todo.status) }];
    });
    const existing = this.findLast((item): item is Extract<ThreadItem, { type: "todos" }> => item.type === "todos", this.lastUserIndex());
    if (existing) {
      let next: TodoEntry[];
      if (merge) {
        const byId = new Map(existing.todos.map((t) => [t.id, t] as const));
        for (const todo of mapped) byId.set(todo.id, todo);
        next = Array.from(byId.values());
      } else {
        next = mapped;
      }
      this.update({ ...existing, todos: next });
      return;
    }
    this.closeSegments();
    this.add({ type: "todos", id: this.nextId("todos"), todos: mapped, createdAt: Date.now(), ...(this.replay ? { replay: true } : {}) });
  }

  addQuestion(requestId: string, title: string | undefined, questions: ReadonlyArray<Question>): QuestionItem {
    this.closeSegments();
    const item: QuestionItem = {
      type: "question",
      id: this.nextId("question"),
      requestId,
      ...(title ? { title } : {}),
      questions,
      state: "pending",
      createdAt: Date.now(),
    };
    this.add(item);
    return item;
  }

  resolveQuestion(requestId: string, state: "answered" | "skipped" | "cancelled", answers?: ReadonlyArray<QuestionAnswer>): void {
    const item = this.findLast((i): i is QuestionItem => i.type === "question" && i.requestId === requestId);
    if (!item || item.state !== "pending") return;
    this.update({ ...item, state, ...(answers ? { answers } : {}) });
  }

  addPlanProposal(requestId: string, input: { name?: string; overview?: string; plan: string; todos: ReadonlyArray<CursorTodo> }): PlanProposalItem {
    this.closeSegments();
    const item: PlanProposalItem = {
      type: "plan_proposal",
      id: this.nextId("planProposal"),
      requestId,
      ...(input.name ? { name: input.name } : {}),
      ...(input.overview ? { overview: input.overview } : {}),
      plan: input.plan,
      todos: input.todos.flatMap((todo, i) => {
        const content = (todo.content ?? todo.title ?? "").trim();
        return content ? [{ id: todo.id ?? `todo-${i}`, content, status: normalizeTodoStatus(todo.status) }] : [];
      }),
      state: "pending",
      createdAt: Date.now(),
    };
    this.add(item);
    return item;
  }

  resolvePlanProposal(requestId: string, state: "accepted" | "rejected" | "cancelled"): void {
    const item = this.findLast((i): i is PlanProposalItem => i.type === "plan_proposal" && i.requestId === requestId);
    if (!item || item.state !== "pending") return;
    this.update({ ...item, state });
  }

  // --- permissions --------------------------------------------------------------

  attachPermission(params: acp.RequestPermissionRequest, requestId: string): ToolItem {
    const toolCall = params.toolCall;
    // The permission request's `content` is the *reason* ("Not in allowlist: npm"), not tool output,
    // so it is shown on the permission prompt and kept out of the tool card's output.
    const { content: _reasonContent, ...toolCallWithoutReason } = toolCall;
    // Make sure the tool card exists (permission can precede the tool_call update).
    if (!this.toolIndex.has(toolCall.toolCallId)) {
      this.upsertTool({ sessionUpdate: "tool_call", ...toolCallWithoutReason } as unknown as acp.ToolCall, "pending");
    } else if (toolCall.rawInput !== undefined || toolCall.title) {
      this.upsertTool({ sessionUpdate: "tool_call_update", ...toolCallWithoutReason } as unknown as acp.ToolCallUpdate, "pending");
    }
    const itemId = this.toolIndex.get(toolCall.toolCallId)!;
    const item = this.get(itemId) as ToolItem;
    const reason = (toolCall.content ?? [])
      .flatMap((entry) => (entry.type === "content" && entry.content.type === "text" ? [entry.content.text] : []))
      .join("\n")
      .trim();
    const options: PermissionOption[] = params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const permission: PermissionState = { requestId, options, state: "pending", ...(reason ? { reason } : {}) };
    const next: ToolItem = { ...item, permission };
    this.update(next);
    return next;
  }

  resolvePermission(requestId: string, selectedOptionId: string | undefined): void {
    const item = this.findLast((i): i is ToolItem => i.type === "tool" && i.permission?.requestId === requestId);
    if (!item || !item.permission || item.permission.state !== "pending") return;
    this.update({
      ...item,
      permission: {
        ...item.permission,
        state: selectedOptionId ? "resolved" : "cancelled",
        ...(selectedOptionId ? { selectedOptionId } : {}),
      },
    });
  }

  pendingPermissionRequestIds(): string[] {
    return this.items.flatMap((item) => (item.type === "tool" && item.permission?.state === "pending" ? [item.permission.requestId] : []));
  }

  // --- internals -------------------------------------------------------------------

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.counter}`;
  }

  private get(id: string): ThreadItem | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  private add(item: ThreadItem): void {
    this.index.set(item.id, this.items.length);
    this.items.push(item);
    this.sink({ type: "item.upsert", item });
  }

  private update(item: ThreadItem): void {
    this.replaceSilently(item);
    this.sink({ type: "item.upsert", item });
  }

  private replaceSilently(item: ThreadItem): void {
    const i = this.index.get(item.id);
    if (i === undefined) return;
    this.items[i] = item;
  }

  private lastUserIndex(): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]?.type === "user") return i;
    }
    return -1;
  }

  private findLast<T extends ThreadItem>(predicate: (item: ThreadItem) => item is T, notBefore = -1): T | undefined {
    for (let i = this.items.length - 1; i > notBefore; i--) {
      const item = this.items[i]!;
      if (predicate(item)) return item;
    }
    return undefined;
  }
}
