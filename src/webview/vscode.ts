import type { PromptAttachmentInput, WebviewToExtension } from "../shared/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = typeof acquireVsCodeApi === "function"
  ? acquireVsCodeApi()
  : { postMessage: () => undefined, getState: () => undefined, setState: () => undefined };

/** Typed send to the extension host. */
export function post(message: WebviewToExtension): void {
  api.postMessage(message);
}

/** Small UI state persisted across webview hide/show. */
export interface PersistedState {
  draft?: string;
  history?: string[];
  expanded?: Record<string, boolean>;
  attachments?: PromptAttachmentInput[];
}

let cached: PersistedState | undefined;

export function getPersisted(): PersistedState {
  if (!cached) {
    const raw = api.getState();
    cached = raw && typeof raw === "object" ? (raw as PersistedState) : {};
  }
  return cached;
}

export function persist(patch: Partial<PersistedState>): void {
  cached = { ...getPersisted(), ...patch };
  api.setState(cached);
}
