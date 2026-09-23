/**
 * Typed ACP client on top of the JSON-RPC peer. Mirrors the subset of the
 * Agent Client Protocol that Cursor's `agent acp` implements, plus Cursor's
 * extension methods (`cursor/*`).
 *
 * Reference: https://agentclientprotocol.com/protocol/schema and
 * https://cursor.com/docs/cli/acp
 */
import type * as acp from "@agentclientprotocol/sdk";
import { JsonRpcPeer, type JsonRpcLogger } from "./jsonrpc";
import type { AgentProcess } from "./AgentProcess";

// --- Cursor extension payloads -------------------------------------------------

export interface CursorAskQuestionRequest {
  readonly toolCallId: string;
  readonly title?: string;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly allowMultiple?: boolean;
  }>;
}

export type CursorAskQuestionResponse = {
  readonly outcome:
    | { readonly outcome: "answered"; readonly answers: ReadonlyArray<{ readonly questionId: string; readonly selectedOptionIds: ReadonlyArray<string>; readonly text?: string }> }
    | { readonly outcome: "skipped"; readonly reason?: string }
    | { readonly outcome: "cancelled" };
};

export interface CursorTodo {
  readonly id?: string;
  readonly content?: string;
  readonly title?: string;
  readonly status?: string;
}

export interface CursorCreatePlanRequest {
  readonly toolCallId: string;
  readonly name?: string;
  readonly overview?: string;
  readonly plan: string;
  readonly todos?: ReadonlyArray<CursorTodo>;
  readonly isProject?: boolean;
  readonly phases?: ReadonlyArray<{ readonly name: string; readonly todos: ReadonlyArray<CursorTodo> }>;
}

export type CursorCreatePlanResponse = {
  readonly outcome:
    | { readonly outcome: "accepted"; readonly planUri?: string }
    | { readonly outcome: "rejected"; readonly reason?: string }
    | { readonly outcome: "cancelled" };
};

export interface CursorUpdateTodosRequest {
  readonly toolCallId: string;
  readonly todos: ReadonlyArray<CursorTodo>;
  readonly merge: boolean;
}

export interface CursorAvailableModel {
  readonly value: string;
  readonly name: string;
  readonly configOptions?: ReadonlyArray<acp.SessionConfigOption>;
}

export interface CursorListAvailableModelsResponse {
  readonly models: ReadonlyArray<CursorAvailableModel>;
}

// --- Client handlers -----------------------------------------------------------

export interface AcpClientHandlers {
  sessionUpdate(notification: acp.SessionNotification): void;
  requestPermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  askQuestion(params: CursorAskQuestionRequest, signal: AbortSignal): Promise<CursorAskQuestionResponse>;
  createPlan(params: CursorCreatePlanRequest, signal: AbortSignal): Promise<CursorCreatePlanResponse>;
  updateTodos(params: CursorUpdateTodosRequest): void;
  /** Any other agent → client request. Return a result or throw. */
  unknownRequest(method: string, params: unknown): Promise<unknown>;
  unknownNotification(method: string, params: unknown): void;
}

export const CLIENT_INFO = { name: "vscode-cursor-acp", version: "0.1.0" } as const;

export class AcpConnection {
  private readonly peer: JsonRpcPeer;

  constructor(readonly process: AgentProcess, handlers: AcpClientHandlers, logger?: JsonRpcLogger) {
    this.peer = new JsonRpcPeer(process.child.stdin, process.child.stdout, logger);
    this.peer.onNotification("session/update", (params) => handlers.sessionUpdate(params as acp.SessionNotification));
    this.peer.onRequest("session/request_permission", (params, signal) =>
      handlers.requestPermission(params as acp.RequestPermissionRequest, signal),
    );
    this.peer.onRequest("cursor/ask_question", (params, signal) => handlers.askQuestion(params as CursorAskQuestionRequest, signal));
    this.peer.onRequest("cursor/create_plan", (params, signal) => handlers.createPlan(params as CursorCreatePlanRequest, signal));
    // Cursor documents update_todos as a notification, but treat a request form gracefully too.
    this.peer.onNotification("cursor/update_todos", (params) => handlers.updateTodos(params as CursorUpdateTodosRequest));
    this.peer.onRequest("cursor/update_todos", (params) => {
      const request = params as CursorUpdateTodosRequest;
      handlers.updateTodos(request);
      return { outcome: { outcome: "accepted", todos: request.todos } };
    });
    this.peer.onUnknownRequest((envelope) => {
      const { method, params } = envelope as { method: string; params: unknown };
      return handlers.unknownRequest(method, params);
    });
    this.peer.onUnknownNotification((envelope) => {
      const { method, params } = envelope as { method: string; params: unknown };
      handlers.unknownNotification(method, params);
    });
    process.onExit((exit) => {
      const reason =
        exit.signal !== null
          ? `The Cursor agent process was terminated by ${exit.signal}.`
          : `The Cursor agent process exited with code ${exit.code ?? "unknown"}.`;
      this.peer.close(reason);
    });
  }

  get isClosed(): boolean {
    return this.peer.isClosed;
  }

  onClose(listener: (reason: string) => void): () => void {
    return this.peer.onClose(listener);
  }

  close(reason = "Connection closed by client."): void {
    this.peer.close(reason);
  }

  // --- Agent methods ----------------------------------------------------------

  initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return this.peer.request("initialize", params);
  }

  authenticate(methodId: string): Promise<acp.AuthenticateResponse> {
    return this.peer.request("authenticate", { methodId });
  }

  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    return this.peer.request("session/new", params);
  }

  loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return this.peer.request("session/load", params);
  }

  listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return this.peer.request("session/list", params);
  }

  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    return this.peer.request("session/prompt", params);
  }

  cancel(sessionId: string): void {
    this.peer.notify("session/cancel", { sessionId });
  }

  setConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    return this.peer.request("session/set_config_option", params);
  }

  setMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    return this.peer.request("session/set_mode", params);
  }

  listAvailableModels(sessionId: string): Promise<CursorListAvailableModelsResponse> {
    return this.peer.request("cursor/list_available_models", { sessionId });
  }

  extRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.peer.request<T>(method, params);
  }
}
