/**
 * Minimal newline-delimited JSON-RPC 2.0 peer over a pair of Node streams.
 *
 * ACP agents (Cursor's `agent acp`) speak JSON-RPC over stdio, one JSON
 * object per line. This class is transport-only: the ACP method semantics
 * live in AcpConnection.
 */
import type { Readable, Writable } from "node:stream";

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class JsonRpcRemoteError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcRemoteError";
  }
}

export class JsonRpcClosedError extends Error {
  constructor(readonly method: string, detail: string) {
    super(detail);
    this.name = "JsonRpcClosedError";
  }
}

type RequestHandler = (params: unknown, signal: AbortSignal) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => Promise<void> | void;

export interface JsonRpcLogger {
  incoming?(line: string): void;
  outgoing?(line: string): void;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const MAX_LINE_LENGTH = 64 * 1024 * 1024;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly inflightIncoming = new Map<string | number, AbortController>();
  private fallbackRequest: RequestHandler | undefined;
  private fallbackNotification: NotificationHandler | undefined;
  /**
   * Partial line received so far. Chunks are only joined once a newline
   * arrives, so a long line delivered in many small chunks costs O(n) rather
   * than O(n²) string concatenation.
   */
  private chunks: string[] = [];
  private pendingLength = 0;
  private closed = false;
  private closeReason: string | undefined;
  private closeListeners = new Set<(reason: string) => void>();
  private endTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly output: Writable,
    input: Readable,
    private readonly logger?: JsonRpcLogger,
  ) {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    // The process 'exit' event (which carries the exit code) usually follows stdout 'end'
    // within milliseconds; give it a moment so the close reason is the informative one.
    input.on("end", () => {
      this.endTimer = setTimeout(() => this.close("The agent closed its output stream."), 250);
    });
    input.on("error", (error: Error) => this.close(`Agent stdout error: ${error.message}`));
    output.on("error", (error: Error) => this.close(`Agent stdin error: ${error.message}`));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onUnknownRequest(handler: RequestHandler): void {
    this.fallbackRequest = handler;
  }

  onUnknownNotification(handler: NotificationHandler): void {
    this.fallbackNotification = handler;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new JsonRpcClosedError(method, this.closeReason ?? "The agent connection is closed."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /** Tear down: rejects all pending requests and aborts in-flight incoming handlers. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = undefined;
    }
    this.chunks = [];
    this.pendingLength = 0;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new JsonRpcClosedError(pending.method, reason));
    }
    for (const controller of this.inflightIncoming.values()) {
      controller.abort();
    }
    this.inflightIncoming.clear();
    const listeners = this.closeListeners;
    this.closeListeners = new Set();
    for (const listener of listeners) {
      try {
        listener(reason);
      } catch {
        // ignore listener failures
      }
    }
  }

  private write(message: unknown): void {
    if (this.closed) return;
    const line = JSON.stringify(message);
    this.logger?.outgoing?.(line);
    try {
      // A destroyed/ended stdin reports failures through the 'error' event (handled in the
      // constructor); the try/catch covers synchronous throws from exotic streams.
      this.output.write(line + "\n");
    } catch (error) {
      this.close(`Failed to write to agent stdin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    let newline = chunk.indexOf("\n");
    if (newline < 0) {
      this.pendingLength += chunk.length;
      if (this.pendingLength > MAX_LINE_LENGTH) {
        this.close("The agent sent a line longer than the maximum supported size.");
        return;
      }
      this.chunks.push(chunk);
      return;
    }
    // First line completes whatever was buffered; the rest of the chunk is scanned in place.
    const head = this.chunks.length > 0 ? this.chunks.join("") + chunk.slice(0, newline) : chunk.slice(0, newline);
    this.chunks = [];
    this.pendingLength = 0;
    this.handleLine(head);
    let start = newline + 1;
    newline = chunk.indexOf("\n", start);
    while (newline >= 0) {
      if (this.closed) return;
      this.handleLine(chunk.slice(start, newline));
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) {
      const rest = chunk.slice(start);
      if (rest.length > MAX_LINE_LENGTH) {
        this.close("The agent sent a line longer than the maximum supported size.");
        return;
      }
      this.chunks.push(rest);
      this.pendingLength = rest.length;
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return;
    this.logger?.incoming?.(line);
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      // Non-JSON output on stdout (e.g. a stray log line). Ignore but keep going.
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method === "string") {
      if (hasId) {
        void this.handleIncomingRequest(message.id as string | number, message.method, message.params);
      } else {
        void this.handleIncomingNotification(message.method, message.params);
      }
      return;
    }
    if (hasId) {
      this.handleResponse(message);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as Partial<JsonRpcError>;
      pending.reject(
        new JsonRpcRemoteError(
          pending.method,
          typeof error.code === "number" ? error.code : -32000,
          typeof error.message === "string" ? error.message : "Unknown agent error",
          error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private async handleIncomingRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const specific = this.requestHandlers.get(method);
    const handler = specific ?? this.fallbackRequest;
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    const controller = new AbortController();
    this.inflightIncoming.set(id, controller);
    try {
      // Fallback handlers receive the method name so they can dispatch on it.
      const result = await handler(specific ? params : { method, params }, controller.signal);
      if (!this.closed) {
        this.write({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (error) {
      if (!this.closed) {
        this.write({
          jsonrpc: "2.0",
          id,
          error: {
            code: error instanceof JsonRpcRemoteError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } finally {
      this.inflightIncoming.delete(id);
    }
  }

  private async handleIncomingNotification(method: string, params: unknown): Promise<void> {
    const handler = this.notificationHandlers.get(method);
    try {
      if (handler) {
        await handler(params);
      } else if (this.fallbackNotification) {
        await this.fallbackNotification({ method, params });
      }
    } catch {
      // Notification handlers must not take the connection down.
    }
  }
}
