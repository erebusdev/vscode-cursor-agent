/**
 * SessionRuntime owns one Cursor ACP process + session for a workspace folder
 * and exposes a simple imperative API to the view layer.
 *
 * Lifecycle: idle → starting → (loading) → ready ⇄ running/cancelling
 *            any → disconnected (process exit) → reconnect → starting…
 */
import type * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { AcpConnection, type AcpClientHandlers, type CursorAskQuestionRequest, type CursorAskQuestionResponse, type CursorAvailableModel, type CursorCreatePlanRequest, type CursorCreatePlanResponse, type CursorUpdateTodosRequest } from "../acp/AcpConnection";
import { AgentProcess, AgentProcessError } from "../acp/AgentProcess";
import { JsonRpcClosedError, JsonRpcRemoteError, type JsonRpcLogger } from "../acp/jsonrpc";
import type {
  ConfigOption,
  ConnectionState,
  ExtensionToWebview,
  PromptAttachmentInput,
  Question,
  QuestionAnswer,
  SessionState,
  SessionSummary,
  UserAttachment,
} from "../../shared/protocol";
import { ThreadModel, isRecord } from "./ThreadModel";

export interface AgentLaunchConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly protocolLogging: boolean;
}

export interface ModelPreferences {
  readonly modelId?: string;
  readonly options?: Readonly<Record<string, string | boolean>>;
}

export interface RuntimeStorage {
  getLastSessionId(): string | undefined;
  setLastSessionId(sessionId: string | undefined): void;
  getModelPreferences(): ModelPreferences;
  setModelPreferences(prefs: ModelPreferences): void;
}

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  protocol(direction: "in" | "out", line: string): void;
  stderr(text: string): void;
}

export interface RuntimeEvents {
  /** Any message for attached webviews. */
  message(message: ExtensionToWebview): void;
  permissionRequested(title: string): void;
  turnFinished(stopReason: string): void;
  questionAsked(title: string): void;
}

export interface SessionRuntimeOptions {
  readonly cwd: string;
  readonly workspaceName: string;
  readonly remoteName?: string;
  readonly getLaunchConfig: () => AgentLaunchConfig;
  readonly storage: RuntimeStorage;
  readonly log: RuntimeLogger;
  readonly events: RuntimeEvents;
}

interface PendingRequest<T> {
  resolve(value: T): void;
  cancel(): void;
}

const SESSION_LOAD_TIMEOUT_MS = 90_000;
const CANCEL_TIMEOUT_MS = 15_000;
const STARTUP_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeError(error: unknown): { text: string; detail?: string } {
  if (error instanceof AgentProcessError) {
    return { text: error.message, ...(error.hint ? { detail: error.hint } : {}) };
  }
  if (error instanceof JsonRpcRemoteError) {
    const data = error.data !== undefined ? `\n${JSON.stringify(error.data, null, 2)}` : "";
    return { text: `${error.method} failed: ${error.message}`, detail: `JSON-RPC error ${error.code}${data}` };
  }
  if (error instanceof JsonRpcClosedError) {
    return { text: error.message };
  }
  if (error instanceof Error) {
    return { text: error.message };
  }
  return { text: String(error) };
}

function toConfigOption(option: acp.SessionConfigOption): ConfigOption {
  const options: ConfigOption["options"] =
    option.type === "select"
      ? option.options.flatMap((entry) =>
          "value" in entry
            ? [{ value: entry.value, name: entry.name, ...(entry.description ? { description: entry.description } : {}) }]
            : entry.options.map((sub) => ({ value: sub.value, name: sub.name, ...(sub.description ? { description: sub.description } : {}) })),
        )
      : [];
  return {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
    ...(option.category ? { category: option.category } : {}),
    type: option.type,
    currentValue: option.currentValue as string | boolean,
    options,
  };
}

export class SessionRuntime {
  readonly model: ThreadModel;
  private process: AgentProcess | undefined;
  private connection: AcpConnection | undefined;
  private initializeResult: acp.InitializeResponse | undefined;
  private authenticated = false;
  private connectionGeneration = 0;
  private disposed = false;

  private connectionState: ConnectionState = "idle";
  private sessionId: string | undefined;
  private title: string | undefined;
  private modes: SessionState["modes"];
  private models: SessionState["models"];
  private configOptions: ConfigOption[] = [];
  private modelCatalog: CursorAvailableModel[] = [];
  /** Values we set via session/set_config_option, keyed by model id (the catalog may lag behind). */
  private readonly modelOptionOverrides = new Map<string, Record<string, string | boolean>>();
  private availableCommands: SessionState["availableCommands"] = [];
  private lastError: string | undefined;
  private agentVersion: string | undefined;

  private activePrompt: Promise<acp.PromptResponse> | undefined;
  private readonly pendingPermissions = new Map<string, PendingRequest<acp.RequestPermissionResponse>>();
  private readonly pendingQuestions = new Map<string, PendingRequest<CursorAskQuestionResponse>>();
  private readonly pendingPlans = new Map<string, PendingRequest<CursorCreatePlanResponse>>();
  private startPromise: Promise<void> | undefined;
  private connectPromise: Promise<AcpConnection> | undefined;
  private loadingSessionId: string | undefined;

  constructor(private readonly options: SessionRuntimeOptions) {
    this.model = new ThreadModel((message) => this.options.events.message(message), options.cwd);
  }

  // --- state ---------------------------------------------------------------------

  get state(): SessionState {
    const modelOptions = this.currentModelOptions();
    return {
      connection: this.connectionState,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.title ? { title: this.title } : {}),
      cwd: this.options.cwd,
      workspaceName: this.options.workspaceName,
      ...(this.options.remoteName ? { remoteName: this.options.remoteName } : {}),
      agentCommand: this.process?.displayCommand ?? [this.options.getLaunchConfig().command, ...this.options.getLaunchConfig().args, "acp"].join(" "),
      ...(this.agentVersion ? { agentVersion: this.agentVersion } : {}),
      ...(this.modes ? { modes: this.modes } : {}),
      ...(this.models ? { models: this.models } : {}),
      modelOptions,
      availableCommands: this.availableCommands,
      pendingPermissions: this.pendingPermissions.size,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      changedFiles: this.model.changedFiles(),
      ...(this.model.turnStart ? { turnStartedAt: this.model.turnStart } : {}),
    };
  }

  /** Resolved executable path of the running (or configured) agent. */
  get agentExecutable(): string {
    return this.process?.resolvedCommand ?? this.options.getLaunchConfig().command;
  }

  get isRunning(): boolean {
    return this.connectionState === "running" || this.connectionState === "cancelling";
  }

  get hasSession(): boolean {
    return this.sessionId !== undefined && this.connection !== undefined && !this.connection.isClosed;
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.publishState();
  }

  private publishState(): void {
    this.options.events.message({ type: "session", session: this.state });
  }

  private currentModelOptions(): ConfigOption[] {
    const current = this.models?.currentModelId;
    if (!current) return [];
    const entry = this.modelCatalog.find((m) => m.value === current);
    const fromCatalog = entry?.configOptions?.map(toConfigOption) ?? [];
    const overrides = this.modelOptionOverrides.get(current) ?? {};
    // Prefer live values from configOptions (session/set_config_option responses), then our own writes.
    return fromCatalog.map((option) => {
      const live = this.configOptions.find((c) => c.id === option.id);
      const override = overrides[option.id];
      return live ? { ...option, currentValue: live.currentValue } : override !== undefined ? { ...option, currentValue: override } : option;
    });
  }

  // --- connection ------------------------------------------------------------------

  /** Spawns the agent and completes initialize + authenticate. Idempotent while alive. */
  private ensureConnected(): Promise<AcpConnection> {
    if (this.connection && !this.connection.isClosed && this.authenticated) return Promise.resolve(this.connection);
    if (!this.connectPromise) {
      this.connectPromise = this.connect().finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise;
  }

  private async connect(): Promise<AcpConnection> {
    if (this.connection && !this.connection.isClosed && this.authenticated) return this.connection;
    const launch = this.options.getLaunchConfig();
    const generation = ++this.connectionGeneration;
    this.options.log.info(`Launching Cursor agent: ${launch.command} ${[...launch.args, "acp"].join(" ")} (cwd: ${this.options.cwd})`);
    const process = await AgentProcess.spawn({
      command: launch.command,
      args: [...launch.args, "acp"],
      cwd: this.options.cwd,
      env: launch.env,
      onStderr: (text) => this.options.log.stderr(text),
    });
    this.options.log.info(`Agent process started (pid ${process.pid ?? "?"}).`);
    const logger: JsonRpcLogger | undefined = launch.protocolLogging
      ? { incoming: (line) => this.options.log.protocol("in", line), outgoing: (line) => this.options.log.protocol("out", line) }
      : undefined;
    const connection = new AcpConnection(process, this.clientHandlers(generation), logger);
    this.process = process;
    this.connection = connection;
    this.authenticated = false;
    connection.onClose((reason) => this.onConnectionClosed(generation, reason));

    try {
      const init = await withTimeout(
        connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            _meta: { parameterizedModelPicker: true },
          },
          clientInfo: { name: "vscode-cursor-acp", title: "Cursor Agent Chat for VS Code", version: "0.1.0" },
        }),
        STARTUP_TIMEOUT_MS,
        "The agent did not answer `initialize` within 60s.",
      );
      this.initializeResult = init;
      this.agentVersion = init.agentInfo?.version;
      const authMethod = init.authMethods?.find((m) => m.id === "cursor_login") ?? init.authMethods?.[0];
      if (authMethod) {
        try {
          await connection.authenticate(authMethod.id);
        } catch (error) {
          throw new AgentProcessError(
            `Cursor authentication failed: ${describeError(error).text}`,
            "Run `agent login` in a terminal (using the same wrapper/profile) and then reconnect.",
          );
        }
      }
      this.authenticated = true;
      return connection;
    } catch (error) {
      // Retire this connection silently; the caller reports the startup error.
      this.connectionGeneration += 1;
      this.connection = undefined;
      this.process = undefined;
      connection.close("Startup failed.");
      await process.kill();
      throw error;
    }
  }

  private onConnectionClosed(generation: number, reason: string): void {
    if (generation !== this.connectionGeneration || this.disposed) return;
    const stderr = this.process?.stderr.trim();
    this.options.log.warn(`Agent connection closed: ${reason}`);
    const wasRunning = this.isRunning;
    this.cancelAllPending();
    this.activePrompt = undefined;
    this.connection = undefined;
    this.loadingSessionId = undefined;
    this.model.setReplay(false);
    if (wasRunning) this.model.endTurn("error");
    if (this.connectionState !== "idle" && this.connectionState !== "error") {
      this.lastError = reason;
      this.model.addNotice("error", reason, stderr || undefined, ["reconnect", "newSession", "openLogs"]);
      this.setConnectionState("disconnected");
    }
  }

  private clientHandlers(generation: number): AcpClientHandlers {
    const live = () => generation === this.connectionGeneration;
    return {
      sessionUpdate: (notification) => {
        if (!live()) return;
        this.handleSessionUpdate(notification);
      },
      requestPermission: (params, signal) => {
        if (!live()) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return this.handlePermission(params, signal);
      },
      askQuestion: (params, signal) => {
        if (!live()) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return this.handleAskQuestion(params, signal);
      },
      createPlan: (params, signal) => {
        if (!live()) return Promise.resolve({ outcome: { outcome: "cancelled" } });
        return this.handleCreatePlan(params, signal);
      },
      updateTodos: (params: CursorUpdateTodosRequest) => {
        if (!live()) return;
        this.model.setTodos(params.todos ?? [], params.merge !== false);
        this.publishState();
      },
      unknownRequest: async (method, params) => {
        this.options.log.warn(`Unsupported agent request ${method}: ${JSON.stringify(params).slice(0, 500)}`);
        if (method === "cursor/task" || method === "cursor/generate_image") {
          return { outcome: { outcome: "rejected", reason: "Not supported by this client." } };
        }
        throw new JsonRpcRemoteError(method, -32601, `Method not supported by client: ${method}`);
      },
      unknownNotification: (method, params) => {
        this.options.log.info(`Agent notification ${method}: ${JSON.stringify(params).slice(0, 500)}`);
      },
    };
  }

  // --- session setup -----------------------------------------------------------------

  /** Starts (or resumes) the session the view should show. */
  async start(resumeSessionId?: string): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal(resumeSessionId).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(resumeSessionId: string | undefined): Promise<void> {
    this.lastError = undefined;
    this.setConnectionState("starting");
    try {
      const connection = await this.ensureConnected();
      if (resumeSessionId) {
        await this.loadSessionInternal(connection, resumeSessionId);
      } else {
        await this.newSessionInternal(connection);
      }
    } catch (error) {
      const { text, detail } = describeError(error);
      this.options.log.error(`Failed to start session: ${text}${detail ? `\n${detail}` : ""}`);
      this.lastError = text;
      this.model.addNotice("error", text, detail ?? this.process?.stderr.trim() ?? undefined, ["reconnect", "openSettings", "openLogs"]);
      this.sessionId = undefined;
      this.setConnectionState(this.connection && !this.connection.isClosed ? "idle" : "error");
    }
  }

  private async newSessionInternal(connection: AcpConnection): Promise<void> {
    this.resetSessionState();
    const response = await connection.newSession({ cwd: this.options.cwd, mcpServers: [] });
    this.sessionId = response.sessionId;
    // Cursor only persists sessions that received a prompt; remember the id on the first prompt.
    this.applySessionSetup(response);
    this.setConnectionState("ready");
    await this.refreshModelCatalog();
    await this.applyModelPreferences();
    this.options.log.info(`New session ${response.sessionId}`);
  }

  private async loadSessionInternal(connection: AcpConnection, sessionId: string): Promise<void> {
    this.resetSessionState();
    this.sessionId = sessionId;
    this.loadingSessionId = sessionId;
    this.model.setReplay(true);
    this.setConnectionState("loading");
    let response: acp.LoadSessionResponse;
    try {
      response = await withTimeout(
        connection.loadSession({ sessionId, cwd: this.options.cwd, mcpServers: [] }),
        SESSION_LOAD_TIMEOUT_MS,
        "session/load timed out while replaying history.",
      );
    } catch (error) {
      this.loadingSessionId = undefined;
      this.model.setReplay(false);
      if (error instanceof JsonRpcRemoteError) {
        // The session is gone (Cursor does not persist sessions that never received a prompt,
        // and sessions can be deleted). Forget it and fall back to a fresh session.
        this.options.log.warn(`Could not resume session ${sessionId}: ${error.message}. Starting a new session.`);
        if (this.options.storage.getLastSessionId() === sessionId) this.options.storage.setLastSessionId(undefined);
        await this.newSessionInternal(connection);
        this.model.addNotice("info", "The previous session could not be resumed, so a new session was started.", describeError(error).text, []);
        return;
      }
      throw error;
    }
    this.loadingSessionId = undefined;
    this.model.setReplay(false);
    this.applySessionSetup(response);
    if (this.model.getItems().length > 0) {
      this.model.addDivider("Resumed session");
    }
    this.options.storage.setLastSessionId(sessionId);
    this.setConnectionState("ready");
    await this.refreshModelCatalog();
    // session/load does not return the title; recover it from the session list when available.
    if (!this.title && this.initializeResult?.agentCapabilities?.sessionCapabilities?.list) {
      try {
        const listed = (await connection.listSessions({ cwd: this.options.cwd })).sessions.find((s) => s.sessionId === sessionId);
        if (listed?.title) {
          this.title = listed.title;
          this.publishState();
        }
      } catch (error) {
        this.options.log.warn(`Could not read the session title: ${describeError(error).text}`);
      }
    }
    this.options.log.info(`Resumed session ${sessionId}`);
  }

  private resetSessionState(): void {
    this.cancelAllPending();
    this.modelOptionOverrides.clear();
    this.model.reset();
    this.sessionId = undefined;
    this.title = undefined;
    this.modes = undefined;
    this.models = undefined;
    this.configOptions = [];
    this.availableCommands = [];
    this.activePrompt = undefined;
  }

  private applySessionSetup(response: acp.NewSessionResponse | acp.LoadSessionResponse): void {
    if (response.modes) {
      this.modes = {
        currentModeId: response.modes.currentModeId,
        availableModes: response.modes.availableModes.map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) })),
      };
    }
    // Cursor reports `models` (currentModelId + availableModels) alongside the standard fields.
    const models = (response as { models?: { currentModelId?: unknown; availableModels?: unknown } }).models;
    if (models && typeof models.currentModelId === "string" && Array.isArray(models.availableModels)) {
      const available = models.availableModels.filter(
        (m): m is { modelId: string; name: string; description?: string } =>
          isRecord(m) && typeof m.modelId === "string" && typeof m.name === "string",
      );
      this.models = {
        currentModelId: models.currentModelId,
        availableModels: available.map((m) => ({ modelId: m.modelId, name: m.name, ...(m.description ? { description: m.description } : {}) })),
      };
    }
    if (response.configOptions) {
      this.applyConfigOptions(response.configOptions);
    }
  }

  private applyConfigOptions(options: ReadonlyArray<acp.SessionConfigOption>): void {
    this.configOptions = options.map(toConfigOption);
    const mode = this.configOptions.find((o) => o.id === "mode" || o.category === "mode");
    if (mode && typeof mode.currentValue === "string") {
      this.modes = {
        currentModeId: mode.currentValue,
        availableModes: mode.options.length > 0 ? mode.options.map((o) => ({ id: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) })) : (this.modes?.availableModes ?? []),
      };
    }
    const model = this.configOptions.find((o) => o.id === "model" || o.category === "model");
    if (model && typeof model.currentValue === "string") {
      this.models = {
        currentModelId: model.currentValue,
        availableModels: model.options.length > 0 ? model.options.map((o) => ({ modelId: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) })) : (this.models?.availableModels ?? []),
      };
    }
  }

  private async refreshModelCatalog(): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const response = await connection.listAvailableModels(this.sessionId);
      this.modelCatalog = [...(response.models ?? [])];
      this.publishState();
    } catch (error) {
      this.options.log.warn(`cursor/list_available_models failed: ${describeError(error).text}`);
    }
  }

  private async applyModelPreferences(): Promise<void> {
    const prefs = this.options.storage.getModelPreferences();
    if (!prefs.modelId || !this.models) return;
    if (!this.models.availableModels.some((m) => m.modelId === prefs.modelId)) return;
    try {
      if (prefs.modelId !== this.models.currentModelId) {
        await this.setModel(prefs.modelId, false);
      }
      for (const [configId, value] of Object.entries(prefs.options ?? {})) {
        const option = this.currentModelOptions().find((o) => o.id === configId);
        if (!option || option.currentValue === value) continue;
        if (option.options.length > 0 && !option.options.some((o) => o.value === String(value))) continue;
        await this.setConfigOption(configId, value, false);
      }
    } catch (error) {
      this.options.log.warn(`Failed to apply saved model preferences: ${describeError(error).text}`);
    }
  }

  // --- public session commands ------------------------------------------------------------

  async newSession(): Promise<void> {
    if (this.isRunning) await this.cancel();
    await this.start(undefined);
  }

  async loadSession(sessionId: string): Promise<void> {
    if (this.isRunning) await this.cancel();
    await this.start(sessionId);
  }

  /** Re-spawns the agent and reloads the current session (if any). */
  async reconnect(): Promise<void> {
    const sessionId = this.sessionId ?? this.options.storage.getLastSessionId();
    await this.teardownProcess();
    this.setConnectionState("idle");
    await this.start(sessionId);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const connection = await this.ensureConnected();
    if (!this.initializeResult?.agentCapabilities?.sessionCapabilities?.list) {
      throw new Error("This agent does not support listing sessions.");
    }
    const response = await connection.listSessions({ cwd: this.options.cwd });
    return response.sessions
      .map((s) => ({
        sessionId: s.sessionId,
        ...(s.title ? { title: s.title } : {}),
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
      }))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  // --- prompting ---------------------------------------------------------------------

  async prompt(text: string, attachments: ReadonlyArray<PromptAttachmentInput>): Promise<void> {
    if (this.isRunning) {
      this.options.events.message({ type: "toast", level: "warning", text: "The agent is still working. Stop it or wait for it to finish." });
      return;
    }
    if (!this.hasSession) {
      await this.start(this.sessionId ?? undefined);
      if (!this.hasSession) return;
    }
    const connection = this.connection!;
    const sessionId = this.sessionId!;
    const trimmed = text.trim();
    const blocks: acp.ContentBlock[] = [];
    const uiAttachments: UserAttachment[] = [];
    const contextParts: string[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.data && attachment.mimeType) {
        blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
        uiAttachments.push({ kind: "image", label: attachment.label, previewDataUrl: `data:${attachment.mimeType};base64,${attachment.data.slice(0, 200_000)}` });
      } else if (attachment.kind === "selection" && attachment.path) {
        const range = attachment.startLine ? `#L${attachment.startLine}${attachment.endLine && attachment.endLine !== attachment.startLine ? `-${attachment.endLine}` : ""}` : "";
        contextParts.push(`Selected code from ${attachment.path}${range}:\n\`\`\`\n${attachment.text ?? ""}\n\`\`\``);
        uiAttachments.push({ kind: "selection", label: attachment.label, path: attachment.path, ...(attachment.startLine ? { startLine: attachment.startLine } : {}), ...(attachment.endLine ? { endLine: attachment.endLine } : {}) });
      } else if (attachment.kind === "file" && attachment.path) {
        contextParts.push(`Referenced file: ${attachment.path}`);
        uiAttachments.push({ kind: "file", label: attachment.label, path: attachment.path });
      }
    }
    const isSlashCommand = /^\/[^\s/]+(?:\s|$)/.test(trimmed);
    const promptText = isSlashCommand || contextParts.length === 0 ? trimmed : `${trimmed}\n\n${contextParts.join("\n\n")}`;
    if (promptText) blocks.unshift({ type: "text", text: promptText });
    if (blocks.length === 0) return;

    this.model.beginTurn(trimmed, uiAttachments);
    this.options.storage.setLastSessionId(sessionId);
    this.setConnectionState("running");
    const request = connection.prompt({ sessionId, prompt: blocks });
    this.activePrompt = request;
    let stopReason = "error";
    try {
      const response = await request;
      stopReason = response.stopReason;
      this.options.log.info(`Turn finished: ${stopReason}`);
    } catch (error) {
      if (error instanceof JsonRpcClosedError) {
        // Handled by onConnectionClosed (disconnected notice + turn end).
        return;
      }
      const { text: message, detail } = describeError(error);
      this.options.log.error(`Prompt failed: ${message}`);
      this.model.addNotice("error", message, detail, ["retry"]);
    } finally {
      if (this.activePrompt === request) {
        this.activePrompt = undefined;
        this.cancelAllPending();
        if (this.connectionState === "running" || this.connectionState === "cancelling") {
          this.model.endTurn(stopReason);
          this.setConnectionState("ready");
          this.options.events.turnFinished(stopReason);
        }
      }
    }
  }

  async cancel(): Promise<void> {
    const connection = this.connection;
    const sessionId = this.sessionId;
    const active = this.activePrompt;
    if (!connection || !sessionId || !active || connection.isClosed) return;
    this.setConnectionState("cancelling");
    this.options.log.info("Cancelling current turn.");
    // Per ACP, pending permission requests must be answered with `cancelled` once we cancel.
    this.cancelAllPending();
    connection.cancel(sessionId);
    try {
      await withTimeout(active.catch(() => undefined), CANCEL_TIMEOUT_MS, "cancel timeout");
    } catch {
      this.options.log.warn("The agent did not acknowledge cancellation in time; stopping the process.");
      this.model.addNotice("warning", "The agent did not stop in time, so its process was terminated.", undefined, ["reconnect"]);
      await this.teardownProcess();
      this.model.endTurn("cancelled");
      this.setConnectionState("disconnected");
    }
  }

  // --- agent → client requests ------------------------------------------------------------

  private handlePermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const requestId = randomUUID();
    const item = this.model.attachPermission(params, requestId);
    this.options.log.info(`Permission requested: ${item.title}`);
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const finish = (response: acp.RequestPermissionResponse, selected: string | undefined) => {
        if (!this.pendingPermissions.delete(requestId)) return;
        this.model.resolvePermission(requestId, selected);
        this.publishState();
        resolve(response);
      };
      this.pendingPermissions.set(requestId, {
        resolve: (response) => finish(response, response.outcome.outcome === "selected" ? response.outcome.optionId : undefined),
        cancel: () => finish({ outcome: { outcome: "cancelled" } }, undefined),
      });
      signal.addEventListener("abort", () => finish({ outcome: { outcome: "cancelled" } }, undefined));
      this.publishState();
      this.options.events.permissionRequested(item.command ?? item.title);
    });
  }

  respondToPermission(requestId: string, optionId: string): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.options.log.info(`Permission ${requestId}: ${optionId}`);
    pending.resolve({ outcome: { outcome: "selected", optionId } });
  }

  private handleAskQuestion(params: CursorAskQuestionRequest, signal: AbortSignal): Promise<CursorAskQuestionResponse> {
    const requestId = randomUUID();
    const questions: Question[] = (params.questions ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      allowMultiple: q.allowMultiple === true,
    }));
    this.model.addQuestion(requestId, params.title, questions);
    this.options.events.questionAsked(params.title ?? questions[0]?.prompt ?? "The agent has a question");
    return new Promise<CursorAskQuestionResponse>((resolve) => {
      const finish = (response: CursorAskQuestionResponse) => {
        if (!this.pendingQuestions.delete(requestId)) return;
        const state = response.outcome.outcome === "answered" ? "answered" : response.outcome.outcome === "skipped" ? "skipped" : "cancelled";
        this.model.resolveQuestion(requestId, state, response.outcome.outcome === "answered" ? response.outcome.answers : undefined);
        resolve(response);
      };
      this.pendingQuestions.set(requestId, { resolve: finish, cancel: () => finish({ outcome: { outcome: "cancelled" } }) });
      signal.addEventListener("abort", () => finish({ outcome: { outcome: "cancelled" } }));
    });
  }

  respondToQuestion(requestId: string, answers: ReadonlyArray<QuestionAnswer>): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    pending.resolve({
      outcome: {
        outcome: "answered",
        answers: answers.map((a) => ({ questionId: a.questionId, selectedOptionIds: a.selectedOptionIds, ...(a.text ? { text: a.text } : {}) })),
      },
    });
  }

  skipQuestion(requestId: string): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    pending.resolve({ outcome: { outcome: "skipped", reason: "The user skipped the question." } });
  }

  private handleCreatePlan(params: CursorCreatePlanRequest, signal: AbortSignal): Promise<CursorCreatePlanResponse> {
    const requestId = randomUUID();
    this.model.addPlanProposal(requestId, {
      ...(params.name ? { name: params.name } : {}),
      ...(params.overview ? { overview: params.overview } : {}),
      plan: params.plan || "(The agent did not include plan text.)",
      todos: params.todos ?? params.phases?.flatMap((p) => p.todos) ?? [],
    });
    this.options.events.questionAsked(params.name ? `Plan: ${params.name}` : "The agent proposed a plan");
    return new Promise<CursorCreatePlanResponse>((resolve) => {
      const finish = (response: CursorCreatePlanResponse) => {
        if (!this.pendingPlans.delete(requestId)) return;
        this.model.resolvePlanProposal(requestId, response.outcome.outcome === "accepted" ? "accepted" : response.outcome.outcome === "rejected" ? "rejected" : "cancelled");
        resolve(response);
      };
      this.pendingPlans.set(requestId, { resolve: finish, cancel: () => finish({ outcome: { outcome: "cancelled" } }) });
      signal.addEventListener("abort", () => finish({ outcome: { outcome: "cancelled" } }));
    });
  }

  respondToPlan(requestId: string, accepted: boolean, reason?: string): void {
    const pending = this.pendingPlans.get(requestId);
    if (!pending) return;
    pending.resolve(accepted ? { outcome: { outcome: "accepted" } } : { outcome: { outcome: "rejected", ...(reason ? { reason } : {}) } });
  }

  private cancelAllPending(): void {
    for (const pending of [...this.pendingPermissions.values(), ...this.pendingQuestions.values(), ...this.pendingPlans.values()]) {
      pending.cancel();
    }
  }

  // --- session updates ----------------------------------------------------------------------

  private handleSessionUpdate(notification: acp.SessionNotification): void {
    if (this.sessionId && notification.sessionId !== this.sessionId) {
      // Updates for a session we are not showing (should not happen with one session per process).
      return;
    }
    const update = notification.update;
    if (this.model.applyUpdate(update)) {
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        // Changed-files summary may have moved; keep the header in sync cheaply.
        if ("content" in update && update.content?.some((c) => c.type === "diff")) this.publishState();
      }
      return;
    }
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.availableCommands = update.availableCommands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input && "hint" in c.input && c.input.hint ? { hint: c.input.hint } : {}),
        }));
        this.publishState();
        return;
      case "current_mode_update":
        if (this.modes) this.modes = { ...this.modes, currentModeId: update.currentModeId };
        this.publishState();
        return;
      case "config_option_update":
        this.applyConfigOptions(update.configOptions);
        this.publishState();
        return;
      case "session_info_update":
        if (typeof update.title === "string" && update.title.trim()) this.title = update.title.trim();
        this.publishState();
        return;
      default: {
        const kind = (update as { sessionUpdate?: string }).sessionUpdate ?? "unknown";
        this.options.log.info(`Ignoring session update: ${kind}`);
      }
    }
  }

  // --- configuration -----------------------------------------------------------------------

  async setMode(modeId: string): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const hasModeOption = this.configOptions.some((o) => o.id === "mode");
      if (hasModeOption) {
        const response = await connection.setConfigOption({ sessionId: this.sessionId, configId: "mode", value: modeId });
        if (response.configOptions) this.applyConfigOptions(response.configOptions);
      } else {
        await connection.setMode({ sessionId: this.sessionId, modeId });
      }
      if (this.modes) this.modes = { ...this.modes, currentModeId: modeId };
      this.publishState();
    } catch (error) {
      this.toastError("Could not switch mode", error);
    }
  }

  async setModel(modelId: string, persist = true): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const response = await connection.setConfigOption({ sessionId: this.sessionId, configId: "model", value: modelId });
      if (response.configOptions) this.applyConfigOptions(response.configOptions);
      if (this.models) this.models = { ...this.models, currentModelId: modelId };
      if (persist) {
        const prefs = this.options.storage.getModelPreferences();
        this.options.storage.setModelPreferences({ modelId, options: prefs.modelId === modelId ? prefs.options : {} });
      }
      this.publishState();
      await this.refreshModelCatalog();
    } catch (error) {
      this.toastError("Could not switch model", error);
    }
  }

  async setConfigOption(configId: string, value: string | boolean, persist = true): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.sessionId) return;
    try {
      const response = await connection.setConfigOption({ sessionId: this.sessionId, configId, value: value as string });
      if (response.configOptions) this.applyConfigOptions(response.configOptions);
      // Model-specific options are only reported by cursor/list_available_models, which may lag; remember our write.
      if (this.models) {
        const modelId = this.models.currentModelId;
        this.modelOptionOverrides.set(modelId, { ...(this.modelOptionOverrides.get(modelId) ?? {}), [configId]: value });
      }
      if (persist && this.models) {
        const prefs = this.options.storage.getModelPreferences();
        this.options.storage.setModelPreferences({
          modelId: this.models.currentModelId,
          options: { ...(prefs.modelId === this.models.currentModelId ? prefs.options : {}), [configId]: value },
        });
      }
      this.publishState();
      await this.refreshModelCatalog();
    } catch (error) {
      this.toastError("Could not update option", error);
    }
  }

  private toastError(prefix: string, error: unknown): void {
    const { text } = describeError(error);
    this.options.log.error(`${prefix}: ${text}`);
    this.options.events.message({ type: "toast", level: "error", text: `${prefix}: ${text}` });
  }

  // --- teardown -----------------------------------------------------------------------------

  private async teardownProcess(): Promise<void> {
    this.connectionGeneration += 1;
    this.cancelAllPending();
    const connection = this.connection;
    const process = this.process;
    this.connection = undefined;
    this.process = undefined;
    this.activePrompt = undefined;
    this.authenticated = false;
    connection?.close("Connection closed by the extension.");
    if (process) await process.kill();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.teardownProcess();
  }
}

export { isRecord };
