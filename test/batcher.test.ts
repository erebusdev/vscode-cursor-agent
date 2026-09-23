import { describe, expect, it } from "vitest";
import type { ExtensionToWebview, ThreadItem, ToolItem } from "../src/shared/protocol";
import { MessageBatcher } from "../src/extension/MessageBatcher";

function make(options: { byteBudget?: number } = {}) {
  const flushed: ExtensionToWebview[][] = [];
  let scheduled: (() => void) | undefined;
  const batcher = new MessageBatcher((messages) => flushed.push([...messages]), {
    ...options,
    setTimer: (callback) => {
      scheduled = callback;
      return 1;
    },
    clearTimer: () => {
      scheduled = undefined;
    },
  });
  const tick = () => {
    const run = scheduled;
    scheduled = undefined;
    run?.();
  };
  return { batcher, flushed, tick, isScheduled: () => scheduled !== undefined };
}

const tool = (id: string, output: string, status: ToolItem["status"] = "in_progress"): ToolItem => ({
  type: "tool",
  id,
  toolCallId: id,
  kind: "execute",
  title: "`cmd`",
  status,
  output,
  diffs: [],
  locations: [],
  createdAt: 1,
});
const upsert = (item: ThreadItem): ExtensionToWebview => ({ type: "item.upsert", item });
const append = (id: string, text: string): ExtensionToWebview => ({ type: "item.append", id, field: "text", text });
const session = (connection: "ready" | "running"): ExtensionToWebview => ({
  type: "session",
  session: { connection, cwd: "/", workspaceName: "w", agentCommand: "agent", modelOptions: [], availableCommands: [], pendingPermissions: 0, changedFiles: [] },
});

describe("MessageBatcher", () => {
  it("keeps only the latest upsert per item, at the position of the first one", () => {
    const { batcher, flushed, tick } = make();
    batcher.push(upsert(tool("t1", "a")));
    batcher.push(upsert(tool("t2", "x")));
    batcher.push(upsert(tool("t1", "ab")));
    batcher.push(upsert(tool("t1", "abc")));
    tick();
    expect(flushed).toHaveLength(1);
    const messages = flushed[0]!;
    expect(messages.map((m) => (m.type === "item.upsert" ? m.item.id : m.type))).toEqual(["t1", "t2"]);
    expect((messages[0] as { item: ToolItem }).item.output).toBe("abc");
  });

  it("drops appends that a later full upsert already contains, but keeps later appends", () => {
    const { batcher, flushed, tick } = make();
    batcher.push({ type: "item.upsert", item: { type: "assistant", id: "a1", text: "he", streaming: true, createdAt: 1 } });
    batcher.push(append("a1", "llo"));
    batcher.push(append("a1", " wor"));
    batcher.push({ type: "item.upsert", item: { type: "assistant", id: "a1", text: "hello wor", streaming: true, createdAt: 1 } });
    batcher.push(append("a1", "ld"));
    tick();
    const messages = flushed[0]!;
    expect(messages.map((m) => m.type)).toEqual(["item.upsert", "item.append"]);
    expect((messages[0] as { item: { text: string } }).item.text).toBe("hello wor");
    expect((messages[1] as { text: string }).text).toBe("ld");
  });

  it("coalesces consecutive appends and separates fields", () => {
    const { batcher, flushed, tick } = make();
    batcher.push(append("a1", "a"));
    batcher.push(append("a1", "b"));
    batcher.push({ type: "item.append", id: "t1", field: "output", text: "o1" });
    batcher.push({ type: "item.append", id: "t1", field: "output", text: "o2" });
    batcher.push(append("a1", "c"));
    tick();
    expect(flushed[0]!.map((m) => (m.type === "item.append" ? `${m.id}:${m.field}:${m.text}` : m.type))).toEqual(["a1:text:ab", "t1:output:o1o2", "a1:text:c"]);
  });

  it("delivers only the latest session state and drops item messages superseded by a reset", () => {
    const { batcher, flushed, tick } = make();
    batcher.push(session("running"));
    batcher.push(upsert(tool("t1", "a")));
    batcher.push(append("a1", "x"));
    batcher.push({ type: "toast", level: "info", text: "hi" });
    batcher.push(session("ready"));
    batcher.push({ type: "items.reset", items: [] });
    batcher.push(upsert(tool("t1", "fresh")));
    tick();
    const messages = flushed[0]!;
    expect(messages.map((m) => m.type)).toEqual(["session", "toast", "items.reset", "item.upsert"]);
    expect((messages[0] as { session: { connection: string } }).session.connection).toBe("ready");
    expect((messages[3] as { item: ToolItem }).item.output).toBe("fresh");
  });

  it("flushes immediately once the queued payload exceeds the byte budget", () => {
    const { batcher, flushed, tick, isScheduled } = make({ byteBudget: 1000 });
    batcher.push(upsert(tool("t1", "x".repeat(600))));
    expect(flushed).toHaveLength(0);
    batcher.push(upsert(tool("t2", "y".repeat(600))));
    expect(flushed).toHaveLength(1);
    expect(isScheduled()).toBe(false);
    batcher.push(append("a1", "tail"));
    tick();
    expect(flushed).toHaveLength(2);
  });

  it("drain delivers pending messages and dispose discards them", () => {
    const { batcher, flushed, tick } = make();
    batcher.push(append("a1", "x"));
    batcher.drain();
    expect(flushed).toHaveLength(1);
    batcher.push(append("a1", "y"));
    batcher.dispose();
    tick();
    expect(flushed).toHaveLength(1);
  });
});
