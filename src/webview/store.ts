import { useEffect, useReducer, useRef } from "preact/hooks";
import type {
  AgentProbe,
  ExtensionSettings,
  ExtensionToWebview,
  PromptAttachmentInput,
  SessionState,
  SessionSummary,
  ThreadItem,
  UiSettings,
  UsageSummary,
} from "../shared/protocol";
import { getPersisted, persist } from "./vscode";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SessionsState {
  readonly list: ReadonlyArray<SessionSummary>;
  readonly loading: boolean;
  readonly error?: string;
}

export interface UsageState {
  readonly summary: UsageSummary | undefined;
  readonly loading: boolean;
}

export interface FileResults {
  readonly requestId: number;
  readonly query: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly name: string }>;
}

export interface Toast {
  readonly id: number;
  readonly level: "info" | "warning" | "error";
  readonly text: string;
}

export interface StoreState {
  /** True once the first snapshot arrived. */
  ready: boolean;
  session: SessionState;
  settings: UiSettings;
  /** Ordered item ids. New array reference only when membership/order changes. */
  ids: ReadonlyArray<string>;
  /** Items by id. Each entry is replaced immutably on change. */
  items: Map<string, ThreadItem>;
  sessions: SessionsState;
  usage: UsageState;
  /** Full extension settings (for the in-app settings panel). */
  extSettings: ExtensionSettings | undefined;
  /** Last agent executable probe. */
  probe: AgentProbe | undefined;
  /** Whether the settings view is shown in place of the transcript. */
  settingsOpen: boolean;
  /** Whether the detailed usage view is shown in place of the transcript. */
  usageOpen: boolean;
  /** Progress of a guided setup step (installer / login running in a terminal). */
  setupStatus: { phase: "idle" | "installing" | "loggingIn"; text?: string };
  /** Latest @-mention file search results. */
  fileResults: FileResults | undefined;
  toasts: ReadonlyArray<Toast>;
  attachments: ReadonlyArray<PromptAttachmentInput>;
  /** Draft restored by the host (snapshot). */
  hostDraft: string | undefined;
  /** Incremented whenever the whole list is replaced (snapshot / items.reset). */
  resetSeq: number;
}

const EMPTY_SESSION: SessionState = {
  connection: "idle",
  cwd: "",
  workspaceName: "",
  agentCommand: "",
  modelOptions: [],
  availableCommands: [],
  pendingPermissions: 0,
  changedFiles: [],
};

const state: StoreState = {
  ready: false,
  session: EMPTY_SESSION,
  settings: { sendWithCtrlEnter: false, showThoughts: true },
  ids: [],
  items: new Map(),
  sessions: { list: [], loading: false },
  usage: { summary: undefined, loading: false },
  extSettings: undefined,
  probe: undefined,
  settingsOpen: false,
  usageOpen: false,
  setupStatus: { phase: "idle" },
  fileResults: undefined,
  toasts: [],
  attachments: getPersisted().attachments ?? [],
  hostDraft: undefined,
  resetSeq: 0,
};

export function getState(): StoreState {
  return state;
}

// ---------------------------------------------------------------------------
// Subscriptions (coalesced to one notification per animation frame)
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let scheduled = false;

function notify(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const l of listeners) l();
  });
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to a slice of the store. The component re-renders only when the
 * selected value changes by reference (`Object.is`).
 */
export function useSelector<T>(select: (s: StoreState) => T): T {
  const [, bump] = useReducer<number, void>((n) => n + 1, 0);
  const selectRef = useRef(select);
  selectRef.current = select;
  const value = select(state);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    const check = () => {
      const next = selectRef.current(state);
      if (!Object.is(next, valueRef.current)) {
        valueRef.current = next;
        bump();
      }
    };
    // Catch anything that changed between render and subscription.
    check();
    return subscribe(check);
  }, []);
  return value;
}

export function useItem(id: string): ThreadItem | undefined {
  return useSelector((s) => s.items.get(id));
}

// ---------------------------------------------------------------------------
// Composer events (things that need the textarea, not state)
// ---------------------------------------------------------------------------

export type ComposerEvent = { type: "insert"; text: string } | { type: "focus" };
const composerListeners = new Set<(e: ComposerEvent) => void>();
const pendingComposerEvents: ComposerEvent[] = [];

export function onComposerEvent(listener: (e: ComposerEvent) => void): () => void {
  composerListeners.add(listener);
  // Flush anything that arrived before the composer mounted.
  if (pendingComposerEvents.length) {
    const queued = pendingComposerEvents.splice(0);
    for (const e of queued) listener(e);
  }
  return () => {
    composerListeners.delete(listener);
  };
}

function emitComposer(e: ComposerEvent): void {
  if (composerListeners.size === 0) {
    pendingComposerEvents.push(e);
    return;
  }
  for (const l of composerListeners) l(e);
}

// ---------------------------------------------------------------------------
// Local mutations
// ---------------------------------------------------------------------------

let toastSeq = 0;

/** Ask the composer to take focus (same path the host's composer.focus message uses). */
export function focusComposer(): void {
  emitComposer({ type: "focus" });
}

export function addToast(level: Toast["level"], text: string, ttl = 4000): void {
  const id = ++toastSeq;
  state.toasts = [...state.toasts, { id, level, text }];
  notify();
  setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number): void {
  if (!state.toasts.some((t) => t.id === id)) return;
  state.toasts = state.toasts.filter((t) => t.id !== id);
  notify();
}

export function setAttachments(next: ReadonlyArray<PromptAttachmentInput>): void {
  state.attachments = next;
  persist({ attachments: [...next] });
  notify();
}

export function addAttachment(a: PromptAttachmentInput): void {
  // De-duplicate identical file/selection attachments.
  const dup = state.attachments.some(
    (x) => x.kind === a.kind && x.path === a.path && x.startLine === a.startLine && x.endLine === a.endLine && x.kind !== "image",
  );
  if (dup) return;
  setAttachments([...state.attachments, a]);
}

export function removeAttachment(index: number): void {
  setAttachments(state.attachments.filter((_, i) => i !== index));
}

export function clearAttachments(): void {
  setAttachments([]);
}

export function setSettingsOpen(open: boolean): void {
  if (state.settingsOpen === open) return;
  state.settingsOpen = open;
  if (open) state.usageOpen = false;
  notify();
}

export function setUsageOpen(open: boolean): void {
  if (state.usageOpen === open) return;
  state.usageOpen = open;
  if (open) state.settingsOpen = false;
  notify();
}

// ---------------------------------------------------------------------------
// Reducer for host messages
// ---------------------------------------------------------------------------

function replaceItems(items: ReadonlyArray<ThreadItem>): void {
  const map = new Map<string, ThreadItem>();
  const ids: string[] = [];
  for (const it of items) {
    if (!map.has(it.id)) ids.push(it.id);
    map.set(it.id, it);
  }
  state.items = map;
  state.ids = ids;
  state.resetSeq++;
}

export function handleMessage(msg: ExtensionToWebview): void {
  switch (msg.type) {
    case "snapshot": {
      state.session = msg.session;
      state.settings = msg.settings;
      state.hostDraft = msg.draft;
      state.ready = true;
      replaceItems(msg.items);
      break;
    }
    case "session": {
      state.session = msg.session;
      break;
    }
    case "settings": {
      state.settings = msg.settings;
      break;
    }
    case "item.upsert": {
      const { item } = msg;
      if (!state.items.has(item.id)) state.ids = [...state.ids, item.id];
      state.items.set(item.id, item);
      break;
    }
    case "item.append": {
      // Hot path: one object copy + string concat, no list rebuild.
      const it = state.items.get(msg.id);
      if (!it) return;
      if (msg.field === "text" && (it.type === "assistant" || it.type === "thought")) {
        state.items.set(msg.id, { ...it, text: it.text + msg.text });
      } else if (msg.field === "output" && it.type === "tool") {
        state.items.set(msg.id, { ...it, output: it.output + msg.text });
      } else {
        return;
      }
      break;
    }
    case "items.reset": {
      replaceItems(msg.items);
      break;
    }
    case "sessions": {
      state.sessions = { list: msg.sessions, loading: msg.loading, error: msg.error };
      break;
    }
    case "extensionSettings": {
      state.extSettings = msg.settings;
      break;
    }
    case "agentProbe": {
      state.probe = msg.probe;
      break;
    }
    case "files.results": {
      state.fileResults = { requestId: msg.requestId, query: msg.query, files: msg.files };
      break;
    }
    case "setupStatus": {
      state.setupStatus = msg.status;
      break;
    }
    case "showSettings": {
      state.settingsOpen = true;
      state.usageOpen = false;
      break;
    }
    case "usage": {
      // Keep the last good summary while a refresh is in flight.
      state.usage = { summary: msg.usage ?? (msg.loading ? state.usage.summary : undefined), loading: msg.loading };
      break;
    }
    case "composer.insert": {
      emitComposer({ type: "insert", text: msg.text });
      return;
    }
    case "composer.attach": {
      addAttachment(msg.attachment);
      return;
    }
    case "composer.focus": {
      emitComposer({ type: "focus" });
      return;
    }
    case "toast": {
      addToast(msg.level, msg.text);
      return;
    }
    default:
      return;
  }
  notify();
}

// ---------------------------------------------------------------------------
// Helpers over the item list
// ---------------------------------------------------------------------------

/** First tool item with a pending permission request, in transcript order. */
export function findPendingPermission(): { itemId: string; requestId: string; options: ThreadItem & { type: "tool" } } | undefined {
  for (const id of state.ids) {
    const it = state.items.get(id);
    if (it && it.type === "tool" && it.permission?.state === "pending") {
      return { itemId: id, requestId: it.permission.requestId, options: it };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Expansion overrides (persisted)
// ---------------------------------------------------------------------------

const expanded: Record<string, boolean> = { ...(getPersisted().expanded ?? {}) };

export function getExpandedOverride(key: string): boolean | undefined {
  return expanded[key];
}

export function setExpandedOverride(key: string, value: boolean | undefined): void {
  if (value === undefined) delete expanded[key];
  else expanded[key] = value;
  // Keep the persisted map bounded.
  const keys = Object.keys(expanded);
  if (keys.length > 500) {
    for (const k of keys.slice(0, keys.length - 400)) delete expanded[k];
  }
  persist({ expanded: { ...expanded } });
}
