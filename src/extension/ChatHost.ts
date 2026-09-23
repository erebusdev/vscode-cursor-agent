/**
 * ChatHost connects the SessionRuntime to one or more webviews (the sidebar
 * view and optional editor panels), handles messages from the UI, and does
 * VS Code-side actions (open files, show diffs, notifications, badges).
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionToWebview, PromptAttachmentInput, UiSettings, WebviewToExtension } from "../shared/protocol";
import type { SessionRuntime } from "./session/SessionRuntime";
import { DiffContentProvider } from "./DiffContentProvider";
import { fetchCursorUsage } from "./session/usage";
import { probeAgent, readExtensionSettings, resetExtensionSetting, updateExtensionSetting } from "./settings";

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

interface Attached {
  readonly webview: vscode.Webview;
  readonly isVisible: () => boolean;
  readonly reveal: () => void;
  ready: boolean;
}

/** Coalesces streaming appends so the webview receives at most ~60 messages/s. */
class MessageBatcher {
  private queue: ExtensionToWebview[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly flush: (messages: ReadonlyArray<ExtensionToWebview>) => void) {}

  push(message: ExtensionToWebview): void {
    const last = this.queue[this.queue.length - 1];
    if (message.type === "item.append" && last?.type === "item.append" && last.id === message.id && last.field === message.field) {
      this.queue[this.queue.length - 1] = { ...last, text: last.text + message.text };
    } else if (message.type === "session" && last?.type === "session") {
      this.queue[this.queue.length - 1] = message;
    } else {
      this.queue.push(message);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.drain(), 16);
    }
  }

  drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    const messages = this.queue;
    this.queue = [];
    this.flush(messages);
  }
}

export class ChatHost implements vscode.Disposable {
  private readonly attached = new Set<Attached>();
  private readonly batcher = new MessageBatcher((messages) => this.broadcast(messages));
  private readonly disposables: vscode.Disposable[] = [];
  private draft = "";
  private view: vscode.WebviewView | undefined;
  /** Fires once, the first time a webview reports ready (used by the dev script hook). */
  onFirstReady: (() => void) | undefined;
  private firstReadyFired = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly runtime: SessionRuntime,
    private readonly diffs: DiffContentProvider,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("cursorAcp")) {
          this.send({ type: "settings", settings: this.uiSettings() });
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          if (event.affectsConfiguration("cursorAcp.agentPath") || event.affectsConfiguration("cursorAcp.environment")) {
            void this.probe();
          }
        }
      }),
    );
  }

  // --- runtime events -------------------------------------------------------------

  /** Called by the runtime for every UI message. */
  onRuntimeMessage(message: ExtensionToWebview): void {
    this.batcher.push(message);
    if (message.type === "session") {
      this.updateBadge(message.session.pendingPermissions);
      const title = this.panelTitle();
      for (const panel of this.panels) if (panel.title !== title) panel.title = title;
    }
  }

  onPermissionRequested(title: string): void {
    if (!this.anyVisible() && this.notifyWhenHidden()) {
      void vscode.window.showWarningMessage(`Cursor Agent needs permission: ${title}`, "Review").then((choice) => {
        if (choice === "Review") this.reveal();
      });
    }
  }

  onQuestionAsked(title: string): void {
    if (!this.anyVisible() && this.notifyWhenHidden()) {
      void vscode.window.showInformationMessage(`Cursor Agent: ${title}`, "Open").then((choice) => {
        if (choice === "Open") this.reveal();
      });
    }
  }

  onTurnFinished(stopReason: string): void {
    if (!this.anyVisible() && this.notifyWhenHidden()) {
      const text = stopReason === "end_turn" ? "Cursor Agent finished." : `Cursor Agent stopped (${stopReason.replace(/_/g, " ")}).`;
      void vscode.window.showInformationMessage(text, "Open").then((choice) => {
        if (choice === "Open") this.reveal();
      });
    }
  }

  // --- views --------------------------------------------------------------------------

  attachView(view: vscode.WebviewView): void {
    this.view = view;
    const attached = this.attach(view.webview, () => view.visible, () => view.show?.(true));
    view.onDidDispose(() => {
      this.attached.delete(attached);
      if (this.view === view) this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      void vscode.commands.executeCommand("setContext", "cursorAcp.viewFocused", view.visible);
    });
  }

  private readonly panels = new Set<vscode.WebviewPanel>();

  attachPanel(panel: vscode.WebviewPanel): void {
    const attached = this.attach(panel.webview, () => panel.visible, () => panel.reveal());
    this.panels.add(panel);
    panel.title = this.panelTitle();
    panel.onDidDispose(() => {
      this.attached.delete(attached);
      this.panels.delete(panel);
    });
  }

  private panelTitle(): string {
    const title = this.runtime.state.title;
    return title ? `Cursor: ${title}` : "Cursor Agent";
  }

  private attach(webview: vscode.Webview, isVisible: () => boolean, reveal: () => void): Attached {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"), vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.html(webview);
    const attached: Attached = { webview, isVisible, reveal, ready: false };
    this.attached.add(attached);
    webview.onDidReceiveMessage((message: WebviewToExtension) => {
      if (message.type === "ready") {
        attached.ready = true;
        this.batcher.drain();
        void webview.postMessage({
          type: "snapshot",
          session: this.runtime.state,
          items: this.runtime.model.getItems(),
          settings: this.uiSettings(),
          draft: this.draft,
        } satisfies ExtensionToWebview);
        if (!this.firstReadyFired) {
          this.firstReadyFired = true;
          this.onFirstReady?.();
        }
        return;
      }
      void this.handleMessage(message);
    });
    return attached;
  }

  private anyVisible(): boolean {
    for (const a of this.attached) if (a.isVisible()) return true;
    return false;
  }

  reveal(): void {
    const first = this.attached.values().next().value as Attached | undefined;
    if (first) first.reveal();
    else void vscode.commands.executeCommand("cursorAcp.chat.focus");
  }

  focusComposer(): void {
    this.reveal();
    this.send({ type: "composer.focus" });
  }

  send(message: ExtensionToWebview): void {
    this.batcher.push(message);
  }

  private broadcast(messages: ReadonlyArray<ExtensionToWebview>): void {
    for (const a of this.attached) {
      if (!a.ready) continue;
      for (const message of messages) void a.webview.postMessage(message);
    }
  }

  private updateBadge(pending: number): void {
    if (!this.view) return;
    this.view.badge = pending > 0 ? { value: pending, tooltip: pending === 1 ? "1 permission request" : `${pending} permission requests` } : undefined;
  }

  private notifyWhenHidden(): boolean {
    return vscode.workspace.getConfiguration("cursorAcp").get<boolean>("notifyWhenHidden", true);
  }

  private uiSettings(): UiSettings {
    const config = vscode.workspace.getConfiguration("cursorAcp");
    return {
      sendWithCtrlEnter: config.get<boolean>("sendWithCtrlEnter", false),
      showThoughts: config.get<boolean>("showThoughts", true),
    };
  }

  // --- messages from the UI -------------------------------------------------------------

  /** Handles a UI message exactly as if the webview had sent it. */
  async handleMessage(message: WebviewToExtension): Promise<void> {
    try {
      switch (message.type) {
        case "prompt":
          this.draft = "";
          await this.runtime.prompt(message.text, message.attachments);
          return;
        case "draft":
          this.draft = message.text;
          return;
        case "cancel":
          await this.runtime.cancel();
          return;
        case "permission.respond":
          this.runtime.respondToPermission(message.requestId, message.optionId);
          return;
        case "question.respond":
          this.runtime.respondToQuestion(message.requestId, message.answers);
          return;
        case "question.skip":
          this.runtime.skipQuestion(message.requestId);
          return;
        case "plan.respond":
          this.runtime.respondToPlan(message.requestId, message.accepted, message.reason);
          return;
        case "session.new":
          await this.runtime.newSession();
          return;
        case "session.load":
          await this.runtime.loadSession(message.sessionId);
          return;
        case "session.list":
          await this.sendSessionList();
          return;
        case "session.reconnect":
          await this.runtime.reconnect();
          return;
        case "mode.set":
          await this.runtime.setMode(message.modeId);
          return;
        case "model.set":
          await this.runtime.setModel(message.modelId);
          return;
        case "config.set":
          await this.runtime.setConfigOption(message.configId, message.value);
          return;
        case "openFile":
          await this.openFile(message.path, message.line);
          return;
        case "openDiff":
          await this.openDiff(message.itemId, message.path);
          return;
        case "copy":
          await vscode.env.clipboard.writeText(message.text);
          return;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "cursorAcp");
          return;
        case "openLogs":
          this.log.show(true);
          return;
        case "openExternal":
          if (/^https?:\/\//i.test(message.url)) await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;
        case "attachActiveFile":
          this.attachActiveFile();
          return;
        case "pickFiles":
          await this.pickFiles();
          return;
        case "usage.refresh":
          await this.refreshUsage();
          return;
        case "files.search":
          await this.searchFiles(message.query, message.requestId);
          return;
        case "settings.get":
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          return;
        case "settings.update":
          await updateExtensionSetting(message.key, message.value);
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          return;
        case "settings.reset":
          await resetExtensionSetting(message.key);
          this.send({ type: "extensionSettings", settings: readExtensionSettings() });
          return;
        case "settings.probe":
          await this.probe();
          return;
        case "settings.browseAgent": {
          const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: "Use as Cursor Agent executable", title: "Select the Cursor Agent CLI (or a wrapper script)" });
          const uri = picked?.[0];
          if (uri) {
            await updateExtensionSetting("agentPath", uri.fsPath);
            this.send({ type: "extensionSettings", settings: readExtensionSettings() });
            await this.probe();
          }
          return;
        }
        default:
          return;
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.log.error(`UI action failed: ${text}`);
      this.send({ type: "toast", level: "error", text });
    }
  }

  private usageInFlight: Promise<void> | undefined;

  private fileIndex: { files: ReadonlyArray<{ path: string; name: string }>; builtAt: number } | undefined;

  /** Fuzzy-ish workspace file search for @-mentions in the composer. */
  private async searchFiles(query: string, requestId: number): Promise<void> {
    if (!this.fileIndex || Date.now() - this.fileIndex.builtAt > 30_000) {
      const uris = await vscode.workspace.findFiles("**/*", "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.next/**}", 5000);
      const files = uris.map((uri) => {
        const path = vscode.workspace.asRelativePath(uri, false);
        return { path, name: basename(path) };
      });
      this.fileIndex = { files, builtAt: Date.now() };
    }
    const q = query.trim().toLowerCase();
    const scored = this.fileIndex.files
      .map((file) => {
        const name = file.name.toLowerCase();
        const path = file.path.toLowerCase();
        let score = 0;
        if (!q) score = 1;
        else if (name.startsWith(q)) score = 100 - name.length;
        else if (name.includes(q)) score = 60 - name.length / 10;
        else if (path.includes(q)) score = 30 - path.length / 50;
        else if (isSubsequence(q, path)) score = 10 - path.length / 100;
        return { file, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((entry) => entry.file);
    this.send({ type: "files.results", requestId, query, files: scored });
  }

  /** Resolves the configured executable and reads its version; results go to the settings panel. */
  async probe(): Promise<void> {
    const settings = readExtensionSettings();
    this.send({ type: "agentProbe", probe: { state: "checking", configuredPath: settings.agentPath, checkedAt: Date.now() } });
    const env: NodeJS.ProcessEnv = { ...process.env, ...settings.environment };
    const probe = await probeAgent(settings.agentPath, env);
    this.log.info(`Agent probe: ${probe.state}${probe.resolvedPath ? ` (${probe.resolvedPath}${probe.version ? `, ${probe.version}` : ""})` : ""}${probe.error ? ` – ${probe.error}` : ""}`);
    this.send({ type: "agentProbe", probe });
  }

  /** Asks the UI to open the settings panel (e.g. when the executable is missing). */
  showSettings(): void {
    this.send({ type: "showSettings" });
  }

  async refreshUsage(): Promise<void> {
    if (this.usageInFlight) return this.usageInFlight;
    this.send({ type: "usage", usage: undefined, loading: true });
    const config = vscode.workspace.getConfiguration("cursorAcp");
    const configDir = config.get<string>("configDir", "").trim();
    const agentPath = this.runtime.agentExecutable;
    const extraEnv = config.get<Record<string, string>>("environment", {});
    this.usageInFlight = fetchCursorUsage({
      ...(configDir ? { configDir } : {}),
      ...(agentPath ? { agentPath } : {}),
      env: { ...process.env, ...extraEnv },
    })
      .then((usage) => this.send({ type: "usage", usage, loading: false }))
      .finally(() => {
        this.usageInFlight = undefined;
      });
    return this.usageInFlight;
  }

  async sendSessionList(): Promise<void> {
    this.send({ type: "sessions", sessions: [], loading: true });
    try {
      const sessions = await this.runtime.listSessions();
      this.send({ type: "sessions", sessions, loading: false });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.send({ type: "sessions", sessions: [], loading: false, error: text });
    }
  }

  // --- editor integration ---------------------------------------------------------------

  private resolveUri(path: string): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const isAbsolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    if (isAbsolute) {
      // Keep the remote authority when running on a remote extension host.
      return folder ? folder.uri.with({ path }) : vscode.Uri.file(path);
    }
    return folder ? vscode.Uri.joinPath(folder.uri, path) : vscode.Uri.file(path);
  }

  private async openFile(path: string, line?: number): Promise<void> {
    const uri = this.resolveUri(path);
    const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: false };
    if (line && line > 0) {
      const position = new vscode.Position(line - 1, 0);
      options.selection = new vscode.Range(position, position);
    }
    await vscode.window.showTextDocument(uri, options);
  }

  private async openDiff(itemId: string, path: string): Promise<void> {
    const items = this.runtime.model.getItems();
    let found: { oldText: string; newText: string } | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.type !== "tool") continue;
      if (itemId && item.id !== itemId) continue;
      const diff = item.diffs.find((d) => d.path === path);
      if (diff) {
        const texts = this.diffs.textsFor(item.id, path);
        if (texts) {
          found = texts;
          break;
        }
      }
    }
    if (!found) {
      await this.openFile(path);
      return;
    }
    const name = basename(path);
    const left = this.diffs.register(`${name} (before)`, found.oldText);
    const right = this.diffs.register(`${name} (after)`, found.newText);
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name}: Cursor edit`, { preview: true });
  }

  private attachActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file" && editor.document.uri.scheme !== "vscode-remote") {
      this.send({ type: "toast", level: "info", text: "No file is open in the editor." });
      return;
    }
    this.send({ type: "composer.attach", attachment: this.fileAttachment(editor.document.uri) });
  }

  attachSelection(editor: vscode.TextEditor): void {
    const selection = editor.selection;
    const document = editor.document;
    if (selection.isEmpty) {
      this.send({ type: "composer.attach", attachment: this.fileAttachment(document.uri) });
      return;
    }
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
    const attachment: PromptAttachmentInput = {
      kind: "selection",
      label: `${basename(path)}:${startLine}${endLine !== startLine ? `-${endLine}` : ""}`,
      path,
      startLine,
      endLine,
      text: document.getText(selection),
    };
    this.send({ type: "composer.attach", attachment });
  }

  private fileAttachment(uri: vscode.Uri): PromptAttachmentInput {
    const path = vscode.workspace.asRelativePath(uri, false);
    return { kind: "file", label: basename(path), path };
  }

  private async pickFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: "Add to chat" });
    for (const uri of uris ?? []) {
      this.send({ type: "composer.attach", attachment: this.fileAttachment(uri) });
    }
  }

  // --- html ---------------------------------------------------------------------------------

  private html(webview: vscode.Webview): string {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "main.css"));
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(dist, "codicon.css"));
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${style}">
<title>Cursor Agent</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
