import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionToWebview, ThreadItem, ToolItem } from "../src/shared/protocol";
import { SessionRuntime, type ModelPreferences } from "../src/extension/session/SessionRuntime";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-agent.mjs");

function makeRuntime(extraEnv: NodeJS.ProcessEnv = {}) {
  const messages: ExtensionToWebview[] = [];
  const events: string[] = [];
  let lastSession: string | undefined;
  let prefs: ModelPreferences = {};
  const runtime = new SessionRuntime({
    cwd: here,
    workspaceName: "test",
    getLaunchConfig: () => ({ command: process.execPath, args: [FAKE_AGENT], env: { ...process.env, ...extraEnv }, protocolLogging: false }),
    storage: {
      getLastSessionId: () => lastSession,
      setLastSessionId: (id) => (lastSession = id),
      getModelPreferences: () => prefs,
      setModelPreferences: (p) => (prefs = p),
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, protocol: () => {}, stderr: () => {} },
    events: {
      message: (m) => messages.push(m),
      permissionRequested: (t) => events.push(`permission:${t}`),
      turnFinished: (r) => events.push(`finished:${r}`),
      questionAsked: (t) => events.push(`question:${t}`),
      agentUnavailable: (e) => events.push(`unavailable:${e}`),
    },
  });
  return { runtime, messages, events, getLastSession: () => lastSession, getPrefs: () => prefs };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const items = (r: SessionRuntime) => r.model.getItems() as ThreadItem[];
const lastAssistant = (r: SessionRuntime) => [...items(r)].reverse().find((i) => i.type === "assistant") as Extract<ThreadItem, { type: "assistant" }> | undefined;

let active: SessionRuntime[] = [];
afterEach(async () => {
  for (const r of active) await r.dispose();
  active = [];
});

describe("SessionRuntime against a fake ACP agent", () => {
  it("starts a session, streams a turn, and records session metadata", async () => {
    const { runtime, events, getLastSession } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBeDefined();
    expect(getLastSession()).toBeUndefined();
    expect(runtime.state.modes?.availableModes.map((m) => m.id)).toEqual(["agent", "ask"]);
    expect(runtime.state.models?.currentModelId).toBe("model-a");
    expect(runtime.state.modelOptions.map((o) => o.id)).toEqual(["effort"]);
    await waitFor(() => runtime.state.availableCommands.length > 0);

    await runtime.prompt("hello there", []);
    expect(runtime.state.connection).toBe("ready");
    expect(lastAssistant(runtime)?.text).toBe("Echo: hello there!");
    expect(items(runtime).map((i) => i.type)).toEqual(["user", "thought", "assistant", "turn_end"]);
    expect(runtime.state.title).toBe("Echo hello ther");
    expect(events).toContain("finished:end_turn");
    expect(getLastSession()).toBe(runtime.state.sessionId);
  });

  it("surfaces permission requests and honours the user's decision", async () => {
    const { runtime, events } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run echo hi", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(tool.permission?.state).toBe("pending");
    expect(tool.permission?.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(events.some((e) => e.startsWith("permission:"))).toBe(true);
    runtime.respondToPermission(tool.permission!.requestId, "allow-once");
    await turn;
    const done = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(done.status).toBe("completed");
    expect(done.output).toBe("hello\n");
    expect(done.exitCode).toBe(0);
    expect(done.permission?.state).toBe("resolved");
    expect(runtime.state.pendingPermissions).toBe(0);
  });

  it("rejects a tool when the user declines", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run echo hi", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    runtime.respondToPermission(tool.permission!.requestId, "reject-once");
    await turn;
    expect((items(runtime).find((i) => i.type === "tool") as ToolItem).status).toBe("failed");
    expect(lastAssistant(runtime)?.text).toBe("Okay, I won't run that.");
  });

  it("cancels a running turn and answers pending permissions with cancelled", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("run echo hi", []);
    await waitFor(() => runtime.state.pendingPermissions === 1);
    await runtime.cancel();
    await turn;
    expect(runtime.state.connection).toBe("ready");
    const end = items(runtime).find((i) => i.type === "turn_end") as Extract<ThreadItem, { type: "turn_end" }>;
    expect(end.stopReason).toBe("cancelled");
    expect((items(runtime).find((i) => i.type === "tool") as ToolItem).permission?.state).toBe("cancelled");
  });

  it("cancels a long-running prompt via session/cancel", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const turn = runtime.prompt("sleep 20000", []);
    await waitFor(() => runtime.state.connection === "running");
    await waitFor(() => lastAssistant(runtime) !== undefined);
    const started = Date.now();
    await runtime.cancel();
    await turn;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runtime.state.connection).toBe("ready");
  });

  it("renders edits as diffs and tracks changed files", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const captured: string[] = [];
    runtime.model.setDiffListener((_id, path, oldText, newText) => captured.push(`${path}|${oldText}|${newText}`));
    await runtime.prompt(`edit ${join(here, "x.txt")}`, []);
    const tool = items(runtime).find((i) => i.type === "tool") as ToolItem;
    expect(tool.kind).toBe("edit");
    expect(tool.diffs[0]?.displayPath).toBe("x.txt");
    expect(tool.diffs[0]?.additions).toBe(2);
    expect(tool.diffs[0]?.deletions).toBe(1);
    expect(runtime.state.changedFiles[0]?.displayPath).toBe("x.txt");
    expect(captured[0]).toBe(`${join(here, "x.txt")}|a\nb\nc\n|a\nB\nc\nd\n`);
  });

  it("answers cursor/ask_question and cursor/create_plan, and applies todos", async () => {
    const { runtime, events } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    const ask = runtime.prompt("ask", []);
    await waitFor(() => items(runtime).some((i) => i.type === "question"));
    const question = items(runtime).find((i) => i.type === "question") as Extract<ThreadItem, { type: "question" }>;
    expect(question.questions[0]?.options.map((o) => o.id)).toEqual(["x", "y"]);
    runtime.respondToQuestion(question.requestId, [{ questionId: "q", selectedOptionIds: ["y"] }]);
    await ask;
    expect(lastAssistant(runtime)?.text).toContain('"answered"');
    expect((items(runtime).find((i) => i.type === "question") as Extract<ThreadItem, { type: "question" }>).state).toBe("answered");
    expect(events.some((e) => e.startsWith("question:"))).toBe(true);

    const plan = runtime.prompt("plan", []);
    await waitFor(() => items(runtime).some((i) => i.type === "plan_proposal"));
    const proposal = items(runtime).find((i) => i.type === "plan_proposal") as Extract<ThreadItem, { type: "plan_proposal" }>;
    expect(proposal.name).toBe("My plan");
    runtime.respondToPlan(proposal.requestId, true);
    await plan;
    expect(lastAssistant(runtime)?.text).toBe("Plan accepted");
    const todos = items(runtime).find((i) => i.type === "todos") as Extract<ThreadItem, { type: "todos" }>;
    expect(todos.todos[0]?.status).toBe("completed");
  });

  it("resumes a session, marking replayed history as history", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("first", []);
    const sessionId = runtime.state.sessionId!;
    const sessions = await runtime.listSessions();
    expect(sessions.map((s) => s.sessionId)).toContain(sessionId);

    await runtime.loadSession(sessionId);
    expect(runtime.state.connection).toBe("ready");
    const replayed = items(runtime);
    expect(replayed.map((i) => i.type)).toEqual(["user", "assistant", "divider"]);
    expect(replayed[0]?.replay).toBe(true);
    expect((replayed[1] as Extract<ThreadItem, { type: "assistant" }>).streaming).toBe(false);
    expect((replayed[1] as Extract<ThreadItem, { type: "assistant" }>).text).toBe("Echo: first!");
  });

  it("falls back to a new session when the stored session no longer exists", async () => {
    const { runtime, getLastSession } = makeRuntime();
    active.push(runtime);
    await runtime.start("does-not-exist");
    expect(runtime.state.connection).toBe("ready");
    expect(runtime.state.sessionId).toBeDefined();
    expect(runtime.state.sessionId).not.toBe("does-not-exist");
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>;
    expect(notice.level).toBe("info");
    expect(notice.detail).toContain("Session not found");
    // Nothing remembered until a prompt is sent (Cursor does not persist empty sessions).
    expect(getLastSession()).toBeUndefined();
    await runtime.prompt("hello", []);
    expect(getLastSession()).toBe(runtime.state.sessionId);
  });

  it("recovers when the agent process dies mid-turn", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("crash", []);
    await waitFor(() => runtime.state.connection === "disconnected");
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>;
    expect(notice.text).toContain("exited with code 3");
    expect(notice.actions).toContain("reconnect");
    // Reconnect spawns a new process; the old session id is gone in the fake agent, so a new one is created.
    await runtime.reconnect();
    expect(["ready", "error"]).toContain(runtime.state.connection);
  });

  it("shows a useful error when the executable cannot be found", async () => {
    const { runtime, events } = makeRuntime();
    active.push(runtime);
    (runtime as unknown as { options: { getLaunchConfig: () => unknown } }).options.getLaunchConfig = () => ({
      command: "/definitely/not/here/agent",
      args: [],
      env: process.env,
      protocolLogging: false,
    });
    await runtime.start();
    expect(runtime.state.connection).toBe("error");
    // A fresh view shows the setup card (driven by the agentUnavailable event) instead of a notice.
    expect(items(runtime).some((i) => i.type === "notice")).toBe(false);
    expect(runtime.state.lastError).toContain("not found");
    expect(events.some((e) => e.startsWith("unavailable:") && e.includes("not found"))).toBe(true);
  });

  it("reports authentication failures with a login hint", async () => {
    const { runtime, events } = makeRuntime({ FAKE_AGENT_AUTH_FAIL: "1" });
    active.push(runtime);
    await runtime.start();
    expect(runtime.state.connection).toBe("error");
    expect(runtime.state.lastError).toContain("authentication failed");
    expect(events.some((e) => e.startsWith("unavailable:") && e.includes("authentication failed"))).toBe(true);
    // Once the transcript has content, failures are reported inline as notices.
    await runtime.prompt("hello", []);
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }> | undefined;
    expect(notice?.text ?? runtime.state.lastError).toContain("authentication failed");
  });

  it("switches mode and model, persisting model preferences", async () => {
    const { runtime, getPrefs } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.setMode("ask");
    expect(runtime.state.modes?.currentModeId).toBe("ask");
    await runtime.setModel("model-b");
    expect(runtime.state.models?.currentModelId).toBe("model-b");
    expect(getPrefs().modelId).toBe("model-b");
    expect(runtime.state.modelOptions).toEqual([]);
    await runtime.setModel("model-a");
    await runtime.setConfigOption("effort", "low");
    expect(runtime.state.modelOptions[0]?.currentValue).toBe("low");
    expect(getPrefs()).toEqual({ modelId: "model-a", options: { effort: "low" } });
  });

  it("prompt errors from the agent become notices, not crashes", async () => {
    const { runtime } = makeRuntime();
    active.push(runtime);
    await runtime.start();
    await runtime.prompt("fail", []);
    expect(runtime.state.connection).toBe("ready");
    const notice = items(runtime).find((i) => i.type === "notice") as Extract<ThreadItem, { type: "notice" }>;
    expect(notice.text).toContain("Something went wrong");
  });
});
