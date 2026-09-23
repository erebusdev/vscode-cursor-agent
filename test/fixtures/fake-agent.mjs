#!/usr/bin/env node
/**
 * A tiny fake ACP agent that mimics the parts of Cursor's `agent acp` the
 * extension relies on. Driven by the prompt text:
 *   "echo <text>"      → streams thought + message chunks
 *   "run <cmd>"        → tool_call execute, requests permission, completes
 *   "edit <path>"      → tool_call edit with a diff
 *   "ask"              → cursor/ask_question request
 *   "plan"             → cursor/create_plan request + cursor/update_todos
 *   "sleep <ms>"       → waits (cancellable) before answering
 *   "crash"            → exits the process with code 3
 *   "fail"             → responds with a JSON-RPC error
 */
import readline from "node:readline";

const sessions = new Map();
let nextId = 1000;
const pending = new Map();
let cancelled = false;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function notify(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
const sleep = (ms) =>
  new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (cancelled || Date.now() - start >= ms) resolve();
      else setTimeout(tick, 10);
    };
    tick();
  });

const modes = {
  currentModeId: "agent",
  availableModes: [
    { id: "agent", name: "Agent", description: "Full agent" },
    { id: "ask", name: "Ask", description: "Q&A" },
  ],
};
const models = {
  currentModelId: "model-a",
  availableModels: [
    { modelId: "model-a", name: "Model A" },
    { modelId: "model-b", name: "Model B" },
  ],
};
function configOptions(sessionId) {
  const s = sessions.get(sessionId);
  return [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: modes.availableModes.map((m) => ({ value: m.id, name: m.name })) },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: models.availableModels.map((m) => ({ value: m.modelId, name: m.name })) },
  ];
}

async function handlePrompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
  const session = sessions.get(sessionId);
  session.history.push({ role: "user", text });
  cancelled = false;
  const finish = (stopReason) => send({ jsonrpc: "2.0", id, result: { stopReason } });

  if (text.startsWith("crash")) {
    process.exit(3);
  }
  if (text.startsWith("fail")) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Something went wrong communicating with the server." } });
    return;
  }
  if (text.startsWith("sleep")) {
    const ms = Number(text.split(" ")[1] ?? "1000");
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sleeping…" } });
    await sleep(ms);
    finish(cancelled ? "cancelled" : "end_turn");
    return;
  }
  if (text.startsWith("run ")) {
    const command = text.slice(4);
    const toolCallId = `call-${nextId++}\nfc_x`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId, title: `\`${command}\``, kind: "execute", status: "pending", rawInput: { command } });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    const permission = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: `\`${command}\``, kind: "execute", status: "pending", content: [{ type: "content", content: { type: "text", text: "Not in allowlist: echo" } }] },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    if (permission.outcome.outcome === "cancelled") {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      finish("cancelled");
      return;
    }
    if (permission.outcome.optionId.startsWith("reject")) {
      notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { error: "rejected by user" } });
      notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Okay, I won't run that." } });
      finish("end_turn");
      return;
    }
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { exitCode: 0, stdout: "hello\n", stderr: "" } });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done: printed hello." } });
    session.history.push({ role: "assistant", text: "Done: printed hello." });
    finish("end_turn");
    return;
  }
  if (text.startsWith("edit ")) {
    const path = text.slice(5);
    const toolCallId = `call-${nextId++}`;
    notify(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Edit File", kind: "edit", status: "pending", rawInput: {} });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, title: `Edit \`${path}\``, rawInput: { path }, locations: [{ path }] });
    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    notify(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "diff", path, oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }],
    });
    finish("end_turn");
    return;
  }
  if (text.startsWith("ask")) {
    const answer = await request("cursor/ask_question", {
      toolCallId: "q1",
      title: "Pick one",
      questions: [{ id: "q", prompt: "Which?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] }],
    });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `You said ${JSON.stringify(answer.outcome)}` } });
    finish("end_turn");
    return;
  }
  if (text.startsWith("plan")) {
    send({ jsonrpc: "2.0", method: "cursor/update_todos", params: { toolCallId: "t1", merge: false, todos: [{ id: "1", content: "First", status: "pending" }] } });
    const result = await request("cursor/create_plan", { toolCallId: "p1", name: "My plan", plan: "# Plan\n\n1. do it", todos: [{ id: "1", content: "First", status: "pending" }] });
    send({ jsonrpc: "2.0", method: "cursor/update_todos", params: { toolCallId: "t1", merge: true, todos: [{ id: "1", content: "First", status: "completed" }] } });
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Plan ${result.outcome.outcome}` } });
    finish("end_turn");
    return;
  }
  // echo
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
  notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "about it." } });
  for (const part of ["Echo: ", text, "!"]) {
    notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: part } });
  }
  session.history.push({ role: "assistant", text: `Echo: ${text}!` });
  notify(sessionId, { sessionUpdate: "session_info_update", title: `Echo ${text.slice(0, 10)}` });
  finish("end_turn");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {} } },
        authMethods: [{ id: "cursor_login", name: "Cursor Login" }],
        agentInfo: { name: "fake-agent", version: "0.0.1" },
      });
      return;
    case "authenticate":
      if (process.env.FAKE_AGENT_AUTH_FAIL) send({ jsonrpc: "2.0", id, error: { code: -32001, message: "Not logged in" } });
      else reply({});
      return;
    case "session/new": {
      const sessionId = `s-${nextId++}`;
      sessions.set(sessionId, { cwd: params.cwd, history: [], mode: "agent", model: "model-a", title: undefined });
      reply({ sessionId, modes, models, configOptions: configOptions(sessionId) });
      setTimeout(() => notify(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compress", description: "Compress context" }] }), 5);
      return;
    }
    case "session/list":
      reply({ sessions: Array.from(sessions, ([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title ?? "Untitled", updatedAt: new Date().toISOString() })) });
      return;
    case "session/load": {
      const s = sessions.get(params.sessionId);
      if (!s) {
        send({ jsonrpc: "2.0", id, error: { code: -32002, message: "Session not found" } });
        return;
      }
      // Replay history *before* answering, exactly like Cursor does.
      for (const entry of s.history) {
        notify(params.sessionId, { sessionUpdate: entry.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: entry.text } });
      }
      setTimeout(() => reply({ modes, models, configOptions: configOptions(params.sessionId) }), 20);
      return;
    }
    case "session/prompt":
      void handlePrompt(id, params);
      return;
    case "session/cancel":
      cancelled = true;
      for (const [pid, p] of pending) {
        // Agent-side: outstanding permission requests will be answered "cancelled" by the client.
      }
      return;
    case "session/set_config_option": {
      const s = sessions.get(params.sessionId);
      if (params.configId === "mode") s.mode = params.value;
      if (params.configId === "model") s.model = params.value;
      reply({ configOptions: configOptions(params.sessionId) });
      return;
    }
    case "cursor/list_available_models":
      reply({
        models: [
          { value: "model-a", name: "Model A", configOptions: [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }] },
          { value: "model-b", name: "Model B" },
        ],
      });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown ${method}` } });
  }
});
rl.on("close", () => process.exit(0));
