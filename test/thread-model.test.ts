import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type { ExtensionToWebview, ThreadItem, ToolItem } from "../src/shared/protocol";
import { ThreadModel, mcpServerDisplayName, mcpToolDisplayName } from "../src/extension/session/ThreadModel";
import { buildFileDiff, normalizeCursorDiff } from "../src/extension/session/diff";
import { parseCursorModelId } from "../src/extension/session/SessionRuntime";

function make() {
  const messages: ExtensionToWebview[] = [];
  const model = new ThreadModel((m) => messages.push(m), "/work/project");
  return { model, messages };
}

const text = (t: string): acp.ContentBlock => ({ type: "text", text: t });

describe("ThreadModel grouping", () => {
  it("merges consecutive message chunks and starts a new block after a tool call", () => {
    const { model, messages } = make();
    model.beginTurn("hi", []);
    model.applyUpdate({ sessionUpdate: "agent_thought_chunk", content: text("Think ") });
    model.applyUpdate({ sessionUpdate: "agent_thought_chunk", content: text("more") });
    model.applyUpdate({ sessionUpdate: "agent_message_chunk", content: text("Hello ") });
    model.applyUpdate({ sessionUpdate: "agent_message_chunk", content: text("world") });
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "c1\nfc", title: "`ls`", kind: "execute", status: "pending", rawInput: { command: "ls" } });
    model.applyUpdate({ sessionUpdate: "agent_message_chunk", content: text("After") });
    model.endTurn("end_turn");

    const types = model.getItems().map((i) => i.type);
    expect(types).toEqual(["user", "thought", "assistant", "tool", "assistant", "turn_end"]);
    const thought = model.getItems()[1] as Extract<ThreadItem, { type: "thought" }>;
    expect(thought.text).toBe("Think more");
    expect(thought.streaming).toBe(false);
    const first = model.getItems()[2] as Extract<ThreadItem, { type: "assistant" }>;
    expect(first.text).toBe("Hello world");
    expect(first.streaming).toBe(false);
    // Streaming deltas are emitted as appends, not full upserts.
    const appends = messages.filter((m) => m.type === "item.append");
    expect(appends.length).toBe(2);
    const tool = model.getItems()[3] as ToolItem;
    expect(tool.command).toBe("ls");
    expect(tool.kind).toBe("execute");
  });

  it("flags replayed history and never marks it streaming", () => {
    const { model } = make();
    model.setReplay(true);
    model.applyUpdate({ sessionUpdate: "user_message_chunk", content: text("old prompt") });
    model.applyUpdate({ sessionUpdate: "agent_message_chunk", content: text("old answer") });
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "replay-0-2", title: "`echo`", kind: "execute", status: "completed", rawInput: { command: "echo" } });
    model.setReplay(false);
    model.addDivider("Resumed session");
    model.beginTurn("new prompt", []);
    model.applyUpdate({ sessionUpdate: "agent_message_chunk", content: text("fresh") });

    const items = model.getItems();
    expect(items.map((i) => i.type)).toEqual(["user", "assistant", "tool", "divider", "user", "assistant"]);
    expect(items[0]?.replay).toBe(true);
    expect((items[1] as Extract<ThreadItem, { type: "assistant" }>).streaming).toBe(false);
    expect(items[1]?.replay).toBe(true);
    expect(items[5]?.replay).toBeUndefined();
    expect((items[5] as Extract<ThreadItem, { type: "assistant" }>).streaming).toBe(true);
  });

  it("merges tool_call_update fields, output and diffs", () => {
    const { model } = make();
    const toolCallId = "call-1";
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId, title: "Edit File", kind: "edit", status: "pending", rawInput: {} });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId, title: "Edit `/work/project/a.txt`", rawInput: { path: "/work/project/a.txt" }, locations: [{ path: "/work/project/a.txt" }] });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    model.applyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "diff", path: "/work/project/a.txt", oldText: "a\nb\n", newText: "a\nc\n" }],
    });
    const tool = model.getItems()[0] as ToolItem;
    expect(tool.status).toBe("completed");
    expect(tool.title).toBe("Edit a.txt");
    expect(tool.subtitle).toBeUndefined();
    expect(tool.locations[0]?.displayPath).toBe("a.txt");
    expect(tool.diffs[0]?.additions).toBe(1);
    expect(tool.diffs[0]?.deletions).toBe(1);
    expect(tool.endedAt).toBeDefined();
    expect(model.changedFiles()).toEqual([{ path: "/work/project/a.txt", displayPath: "a.txt", additions: 1, deletions: 1 }]);
  });

  it("reuses the diff and forwards the full texts once when identical diff content is resent", () => {
    const { model } = make();
    const captured: string[] = [];
    model.setDiffListener((_id, path) => captured.push(path));
    const content: acp.ToolCallContent[] = [{ type: "diff", path: "/work/project/a.txt", oldText: "a\nb\n", newText: "a\nc\n" }];
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", status: "pending" });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "in_progress", content });
    const first = (model.getItems()[0] as ToolItem).diffs[0];
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "in_progress", content: [{ ...content[0]! }] });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed", content: [{ ...content[0]! }] });
    expect((model.getItems()[0] as ToolItem).diffs[0]).toBe(first);
    expect(captured).toEqual(["/work/project/a.txt"]);
    // Changed content is diffed again and forwarded again.
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed", content: [{ type: "diff", path: "/work/project/a.txt", oldText: "a\nb\n", newText: "a\nc\nd\n" }] });
    expect((model.getItems()[0] as ToolItem).diffs[0]).not.toBe(first);
    expect(captured).toHaveLength(2);
  });

  it("does not double count changed files when a finished tool is updated again", () => {
    const { model } = make();
    const content: acp.ToolCallContent[] = [{ type: "diff", path: "/work/project/a.txt", oldText: "a\nb\n", newText: "a\nc\n" }];
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "e", title: "Edit", kind: "edit", status: "pending" });
    expect(model.changedFilesVersion).toBe(0);
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed", content });
    const version = model.changedFilesVersion;
    const before = model.changedFiles();
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed", content });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "e", status: "completed" });
    expect(model.changedFilesVersion).toBe(version);
    expect(model.changedFiles()).toBe(before); // memoised
    expect(before).toEqual([{ path: "/work/project/a.txt", displayPath: "a.txt", additions: 1, deletions: 1 }]);
    // A second tool touching the same file adds to the totals; a corrected diff replaces that tool's share.
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "f", title: "Edit", kind: "edit", status: "completed", content: [{ type: "diff", path: "/work/project/a.txt", oldText: "x\n", newText: "x\ny\nz\n" }] });
    expect(model.changedFiles()[0]).toMatchObject({ additions: 3, deletions: 1 });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "f", status: "completed", content: [{ type: "diff", path: "/work/project/a.txt", oldText: "x\n", newText: "x\ny\n" }] });
    expect(model.changedFiles()[0]).toMatchObject({ additions: 2, deletions: 1 });
    model.reset();
    expect(model.changedFiles()).toEqual([]);
  });

  it("bounds file contents and pretty-printed inputs sent to the UI", () => {
    const { model } = make();
    const big = "z".repeat(300_000);
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "r", title: "Read", kind: "read", status: "completed", rawInput: { path: "/x", big }, rawOutput: { content: big } });
    const tool = model.getItems()[0] as ToolItem;
    expect(tool.fileContent!.length).toBeLessThan(200_100);
    expect(tool.fileContent!.endsWith("[… truncated]")).toBe(true);
    expect(tool.inputText!.length).toBeLessThan(50_100);
  });

  it("shortens bare workspace paths in titles", () => {
    const { model } = make();
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "r", title: "Read /work/project/src/a.ts", kind: "read", status: "completed", rawInput: { path: "/work/project/src/a.ts" } });
    expect((model.getItems()[0] as ToolItem).title).toBe("Read src/a.ts");
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "c", title: "`cat /work/project/x`", kind: "execute", status: "completed", rawInput: { command: "cat /work/project/x" } });
    expect((model.getItems()[1] as ToolItem).title).toBe("`cat /work/project/x`");
  });

  it("captures command output and exit code from rawOutput", () => {
    const { model } = make();
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "c", title: "`echo hi`", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: { exitCode: 0, stdout: "hi\n", stderr: "" } });
    const tool = model.getItems()[0] as ToolItem;
    expect(tool.output).toBe("hi\n");
    expect(tool.exitCode).toBe(0);
  });

  it("attaches and resolves permissions on the tool card", () => {
    const { model } = make();
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "c", title: "`rm -rf x`", kind: "execute", status: "pending", rawInput: { command: "rm -rf x" } });
    model.attachPermission(
      {
        sessionId: "s",
        toolCall: { toolCallId: "c", title: "`rm -rf x`", kind: "execute", status: "pending", content: [{ type: "content", content: text("Not in allowlist: rm") }] },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
      "req-1",
    );
    let tool = model.getItems()[0] as ToolItem;
    expect(tool.permission?.state).toBe("pending");
    expect(tool.permission?.reason).toBe("Not in allowlist: rm");
    expect(tool.output).toBe("");
    expect(model.pendingPermissionRequestIds()).toEqual(["req-1"]);
    model.resolvePermission("req-1", "allow-once");
    tool = model.getItems()[0] as ToolItem;
    expect(tool.permission?.state).toBe("resolved");
    expect(tool.permission?.selectedOptionId).toBe("allow-once");
    expect(model.pendingPermissionRequestIds()).toEqual([]);
  });

  it("creates the tool card when a permission arrives before tool_call", () => {
    const { model } = make();
    model.attachPermission(
      { sessionId: "s", toolCall: { toolCallId: "z", title: "Write file", kind: "edit" }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] },
      "req",
    );
    const tool = model.getItems()[0] as ToolItem;
    expect(tool.kind).toBe("edit");
    expect(tool.permission?.requestId).toBe("req");
  });

  it("merges and replaces todos", () => {
    const { model } = make();
    model.setTodos([{ id: "1", content: "A", status: "pending" }, { id: "2", content: "B", status: "pending" }], false);
    model.setTodos([{ id: "1", content: "A", status: "completed" }], true);
    const todos = model.getItems()[0] as Extract<ThreadItem, { type: "todos" }>;
    expect(todos.todos.map((t) => t.status)).toEqual(["completed", "pending"]);
    model.setTodos([{ id: "9", content: "Z" }], false);
    expect((model.getItems()[0] as Extract<ThreadItem, { type: "todos" }>).todos.map((t) => t.id)).toEqual(["9"]);
    expect(model.getItems().length).toBe(1);
  });

  it("ends a turn with a duration and stop reason", () => {
    const { model } = make();
    model.beginTurn("x", []);
    model.endTurn("cancelled");
    const end = model.getItems()[1] as Extract<ThreadItem, { type: "turn_end" }>;
    expect(end.stopReason).toBe("cancelled");
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("diffs", () => {
  it("normalises Cursor's synthetic new-file header", () => {
    const n = normalizeCursorDiff({ path: "/p/x.md", oldText: "-- /dev/null", newText: "++ b//p/x.md\n# Probe\nhello" });
    expect(n.isNew).toBe(true);
    expect(n.oldText).toBe("");
    expect(n.newText).toBe("# Probe\nhello");
    const diff = buildFileDiff({ path: "/p/x.md", oldText: "-- /dev/null", newText: "++ b//p/x.md\n# Probe\nhello" }, "x.md");
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(0);
    expect(diff.hunks[0]?.lines.every((l) => l.type === "add")).toBe(true);
  });

  it("produces hunks with line numbers", () => {
    const diff = buildFileDiff({ path: "/p/a.ts", oldText: "1\n2\n3\n4\n5\n6\n7\n8\n9\n", newText: "1\n2\n3\n4\nfive\n6\n7\n8\n9\n" }, "a.ts");
    expect(diff.hunks.length).toBe(1);
    const del = diff.hunks[0]!.lines.find((l) => l.type === "del");
    const add = diff.hunks[0]!.lines.find((l) => l.type === "add");
    expect(del?.oldLine).toBe(5);
    expect(add?.newLine).toBe(5);
    expect(add?.text).toBe("five");
  });
});

describe("parseCursorModelId", () => {
  it("splits Cursor's parameterised model ids", () => {
    expect(parseCursorModelId("grok-4.7[context=256k,reasoning_effort=high,fast=true]")).toEqual({ modelId: "grok-4.7", params: { context: "256k", reasoning_effort: "high", fast: "true" } });
    expect(parseCursorModelId("auto-smart")).toEqual({ modelId: "auto-smart", params: {} });
  });
});

describe("MCP tool titles", () => {
  const allow = [{ optionId: "allow-once", name: "Allow", kind: "allow_once" as const }];

  it("names plugin and custom servers readably", () => {
    expect(mcpServerDisplayName("plugin-atlassian-atlassian")).toBe("Atlassian");
    expect(mcpServerDisplayName("plugin-sentry-sentry")).toBe("Sentry");
    expect(mcpServerDisplayName("plugin-cloudflare-cloudflare-docs")).toBe("Cloudflare docs");
    expect(mcpServerDisplayName("plugin-cloudflare-cloudflare-observability")).toBe("Cloudflare observability");
    // Multi-part plugin names: the split where the server repeats the plugin name wins.
    expect(mcpServerDisplayName("plugin-foo-bar-foo-bar")).toBe("Foo bar");
    expect(mcpServerDisplayName("plugin-linear-server")).toBe("Linear server");
    expect(mcpServerDisplayName("github")).toBe("GitHub");
    expect(mcpServerDisplayName("gitlab")).toBe("GitLab");
    expect(mcpServerDisplayName("my-docs_server")).toBe("My docs server");
  });

  it("shows tool names as-is, with snake_case read as words", () => {
    expect(mcpToolDisplayName("atlassianUserInfo")).toBe("atlassianUserInfo");
    expect(mcpToolDisplayName("execute_sentry_tool")).toBe("execute sentry tool");
  });

  it("replaces 'MCP: tool' with server and tool once the update names them (joined title shape)", () => {
    const { model } = make();
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "m1", title: "MCP: tool", kind: "other", status: "pending" });
    expect((model.getItems()[0] as ToolItem).title).toBe("MCP: tool");
    model.applyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "m1",
      title: "plugin-atlassian-atlassian-atlassianUserInfo: atlassianUserInfo",
      rawInput: { providerIdentifier: "plugin-atlassian-atlassian", toolName: "atlassianUserInfo", args: {} },
    });
    let tool = model.getItems()[0] as ToolItem;
    expect(tool.title).toBe("Atlassian · atlassianUserInfo");
    expect(tool.tooltip).toBe("MCP server plugin-atlassian-atlassian, tool atlassianUserInfo");
    expect(tool.mcpPattern).toBe("Mcp(plugin-atlassian-atlassian:atlassianUserInfo)");
    // A later update carrying the generic title again does not bring it back.
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "m1", title: "MCP: tool", status: "completed" });
    tool = model.getItems()[0] as ToolItem;
    expect(tool.title).toBe("Atlassian · atlassianUserInfo");
    expect(tool.status).toBe("completed");
  });

  it("parses the title when rawInput lacks the fields (plain title shape)", () => {
    const { model } = make();
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "m2", title: "MCP: tool", kind: "other", status: "pending" });
    model.applyUpdate({ sessionUpdate: "tool_call_update", toolCallId: "m2", title: "plugin-sentry-sentry: execute_sentry_tool", rawInput: { args: { q: 1 } } });
    const tool = model.getItems()[0] as ToolItem;
    expect(tool.title).toBe("Sentry · execute sentry tool");
    expect(tool.tooltip).toBe("MCP server plugin-sentry-sentry, tool execute_sentry_tool");
    expect(tool.mcpPattern).toBe("Mcp(plugin-sentry-sentry:execute_sentry_tool)");
  });

  it("permission prompts show the friendly title; the approval pattern stays Cursor's", () => {
    const { model } = make();
    const item = model.attachPermission(
      {
        sessionId: "s",
        toolCall: {
          toolCallId: "m3",
          title: "plugin-cloudflare-cloudflare-docs: search_cloudflare_documentation",
          kind: "other",
          rawInput: { providerIdentifier: "plugin-cloudflare-cloudflare-docs", toolName: "search_cloudflare_documentation", args: { query: "kv" } },
          content: [{ type: "content", content: text('```json\n{ "query": "kv" }\n```') }],
        },
        options: allow,
      },
      "req-m",
    );
    expect(item.title).toBe("Cloudflare docs · search cloudflare documentation");
    expect(item.mcpPattern).toBe("Mcp(plugin-cloudflare-cloudflare-docs:search_cloudflare_documentation)");
    expect(item.permission?.reason).toBeUndefined();

    const custom = model.attachPermission({ sessionId: "s", toolCall: { toolCallId: "m4", title: "github-create_issue: create_issue", kind: "other" }, options: allow }, "req-g");
    expect(custom.title).toBe("GitHub · create issue");
    expect(custom.mcpPattern).toBe("Mcp(github:create_issue)");
  });

  it("leaves non-MCP titles alone", () => {
    const { model } = make();
    model.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "r", title: "Read /work/project/src/a.ts", kind: "read", status: "pending" });
    const tool = model.getItems()[0] as ToolItem;
    expect(tool.title).toBe("Read src/a.ts");
    expect(tool.tooltip).toBeUndefined();
  });
});
