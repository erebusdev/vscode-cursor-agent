/**
 * Serves the "before" / "after" texts of agent edits as read-only virtual
 * documents so `vscode.diff` can show them in the native diff editor.
 */
import * as vscode from "vscode";

export const DIFF_SCHEME = "cursor-acp-diff";

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private readonly texts = new Map<string, { oldText: string; newText: string }>();
  private counter = 0;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.query) ?? "";
  }

  /** Remembers the full before/after text for a tool item + path (kept out of the webview payload). */
  remember(itemId: string, path: string, oldText: string, newText: string): void {
    this.texts.set(`${itemId}\u0000${path}`, { oldText, newText });
  }

  textsFor(itemId: string, path: string): { oldText: string; newText: string } | undefined {
    return this.texts.get(`${itemId}\u0000${path}`);
  }

  register(label: string, content: string): vscode.Uri {
    const key = `${++this.counter}`;
    this.documents.set(key, content);
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${label}`, query: key });
  }

  clear(): void {
    this.documents.clear();
    this.texts.clear();
  }
}
