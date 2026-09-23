/**
 * Coalesces extension → webview messages so the UI receives at most one
 * batch per animation frame (~60/s) and never redundant work:
 *
 *  - consecutive `item.append` for the same item and field are concatenated;
 *  - `item.upsert` for an item already queued replaces the queued copy in
 *    place (the earliest position is kept, because the webview orders items by
 *    first arrival) and drops any queued appends for that item, which the
 *    newer full copy already contains;
 *  - only the latest `session` state is delivered;
 *  - `items.reset` drops all queued item messages, which it supersedes.
 *
 * A large upsert (a tool card whose cumulative output is hundreds of KB) can
 * arrive many times per second while a command runs; with this coalescing
 * only the latest copy per frame is serialised across the webview boundary.
 * When the queued payload grows past `byteBudget` it is flushed immediately
 * rather than accumulating until the timer fires.
 */
import type { ExtensionToWebview } from "../shared/protocol";

type Queued = ExtensionToWebview | undefined;

export interface MessageBatcherOptions {
  /** Delay before a queued batch is flushed. */
  readonly intervalMs?: number;
  /** Approximate payload size (characters of text/output) that triggers an immediate flush. */
  readonly byteBudget?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 16;
const DEFAULT_BYTE_BUDGET = 1024 * 1024;

export class MessageBatcher {
  private queue: Queued[] = [];
  /** Position in `queue` of the current upsert per item id. */
  private upsertIndex = new Map<string, number>();
  /** Position of appends per item id + field, so a later upsert can drop them. */
  private appendIndex = new Map<string, number[]>();
  private sessionIndex = -1;
  private estimatedBytes = 0;
  private timer: unknown;
  private readonly intervalMs: number;
  private readonly byteBudget: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly flush: (messages: ReadonlyArray<ExtensionToWebview>) => void,
    options: MessageBatcherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.byteBudget = options.byteBudget ?? DEFAULT_BYTE_BUDGET;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  push(message: ExtensionToWebview): void {
    switch (message.type) {
      case "item.append": {
        const key = `${message.id}\u0000${message.field}`;
        const last = this.queue[this.queue.length - 1];
        if (last?.type === "item.append" && last.id === message.id && last.field === message.field) {
          this.queue[this.queue.length - 1] = { ...last, text: last.text + message.text };
        } else {
          const positions = this.appendIndex.get(key);
          if (positions) positions.push(this.queue.length);
          else this.appendIndex.set(key, [this.queue.length]);
          this.queue.push(message);
        }
        this.estimatedBytes += message.text.length;
        break;
      }
      case "item.upsert": {
        const id = message.item.id;
        const existing = this.upsertIndex.get(id);
        for (const field of ["text", "output"] as const) {
          const key = `${id}\u0000${field}`;
          const positions = this.appendIndex.get(key);
          if (!positions) continue;
          for (const position of positions) this.queue[position] = undefined;
          this.appendIndex.delete(key);
        }
        if (existing !== undefined) {
          this.estimatedBytes -= estimateSize(this.queue[existing]);
          this.queue[existing] = message;
        } else {
          this.upsertIndex.set(id, this.queue.length);
          this.queue.push(message);
        }
        this.estimatedBytes += estimateSize(message);
        break;
      }
      case "items.reset": {
        for (const [i, queued] of this.queue.entries()) {
          if (queued?.type === "item.upsert" || queued?.type === "item.append") this.queue[i] = undefined;
        }
        this.upsertIndex.clear();
        this.appendIndex.clear();
        this.estimatedBytes = 0;
        this.queue.push(message);
        break;
      }
      case "session": {
        if (this.sessionIndex >= 0 && this.queue[this.sessionIndex]?.type === "session") {
          this.queue[this.sessionIndex] = message;
        } else {
          this.sessionIndex = this.queue.length;
          this.queue.push(message);
        }
        break;
      }
      default:
        this.queue.push(message);
    }
    if (this.estimatedBytes >= this.byteBudget) {
      this.drain();
      return;
    }
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => this.drain(), this.intervalMs);
    }
  }

  /** Delivers everything queued right away (also used when a webview becomes ready). */
  drain(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const messages: ExtensionToWebview[] = [];
    for (const queued of this.queue) if (queued) messages.push(queued);
    this.queue = [];
    this.upsertIndex.clear();
    this.appendIndex.clear();
    this.sessionIndex = -1;
    this.estimatedBytes = 0;
    if (messages.length > 0) this.flush(messages);
  }

  /** Drops queued messages and stops the timer. */
  dispose(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.upsertIndex.clear();
    this.appendIndex.clear();
    this.sessionIndex = -1;
    this.estimatedBytes = 0;
  }
}

/** Cheap size estimate: the long strings dominate; structure overhead is ignored. */
function estimateSize(message: Queued): number {
  if (!message) return 0;
  switch (message.type) {
    case "item.append":
      return message.text.length;
    case "item.upsert": {
      const item = message.item;
      switch (item.type) {
        case "assistant":
        case "thought":
        case "user":
          return item.text.length + 64;
        case "tool":
          return item.output.length + (item.fileContent?.length ?? 0) + (item.inputText?.length ?? 0) + item.diffs.reduce((n, d) => n + d.hunks.reduce((m, h) => m + h.lines.length * 40, 0), 0) + 128;
        default:
          return 256;
      }
    }
    default:
      return 0;
  }
}
