/**
 * Serves the "before" / "after" texts of agent edits as read-only virtual
 * documents so `vscode.diff` can show them in the native diff editor.
 *
 * Memory is bounded: the full before/after texts are kept for a limited
 * number of edits (oldest evicted first, and cleared when the transcript is
 * replaced), and virtual documents are dropped as soon as VS Code closes them
 * or when more than a handful are retained.
 */
import * as vscode from "vscode";

export const DIFF_SCHEME = "cursor-acp-diff";

/** Edits whose full texts are kept for the diff editor (each may be a whole file, before and after). */
const MAX_REMEMBERED_EDITS = 200;
/** Virtual documents kept alive (two per opened diff) in case the editor asks for their content again. */
const MAX_DOCUMENTS = 40;

export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents = new Map<string, string>();
  private readonly texts = new Map<string, { oldText: string; newText: string }>();
  private counter = 0;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [this.emitter];

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === DIFF_SCHEME) this.documents.delete(document.uri.query);
      }),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.query) ?? "";
  }

  /** Remembers the full before/after text for a tool item + path (kept out of the webview payload). */
  remember(itemId: string, path: string, oldText: string, newText: string): void {
    const key = `${itemId}\u0000${path}`;
    // Re-insert so the entry counts as most recently used.
    this.texts.delete(key);
    this.texts.set(key, { oldText, newText });
    while (this.texts.size > MAX_REMEMBERED_EDITS) {
      const oldest = this.texts.keys().next().value;
      if (oldest === undefined) break;
      this.texts.delete(oldest);
    }
  }

  textsFor(itemId: string, path: string): { oldText: string; newText: string } | undefined {
    return this.texts.get(`${itemId}\u0000${path}`);
  }

  /** Registers a virtual document and returns a unique URI for it. */
  register(label: string, content: string): vscode.Uri {
    const key = `${++this.counter}`;
    this.documents.set(key, content);
    while (this.documents.size > MAX_DOCUMENTS) {
      const oldest = this.documents.keys().next().value;
      if (oldest === undefined) break;
      this.documents.delete(oldest);
    }
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${label}`, query: key });
  }

  /** Forgets remembered edit texts (the transcript they belonged to is gone). Open diff editors keep working. */
  clearTexts(): void {
    this.texts.clear();
  }

  dispose(): void {
    this.documents.clear();
    this.texts.clear();
    for (const d of this.subscriptions) d.dispose();
  }
}
