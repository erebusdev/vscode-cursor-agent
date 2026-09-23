import * as vscode from "vscode";
import { ChatHost } from "./ChatHost";
import { DIFF_SCHEME, DiffContentProvider } from "./DiffContentProvider";
import { SessionRuntime, type AgentLaunchConfig, type ModelPreferences } from "./session/SessionRuntime";
import { ThreadModel } from "./session/ThreadModel";
import type { WebviewToExtension } from "../shared/protocol";

const PANEL_TYPE = "cursorAcp.panel";

/**
 * The chat lives in the secondary (right-hand) sidebar, where the other AI
 * chat extensions sit, when VS Code supports secondary-sidebar view containers
 * (1.100+). Older versions get an activity-bar container instead.
 */
function supportsSecondarySidebar(): boolean {
  const [major = 0, minor = 0] = vscode.version.split(".").map((part) => Number.parseInt(part, 10));
  return major > 1 || (major === 1 && minor >= 100);
}
const VIEW_ID = supportsSecondarySidebar() ? "cursorAcp.chat" : "cursorAcp.chatLeft";
const ALL_VIEW_IDS = ["cursorAcp.chat", "cursorAcp.chatLeft"] as const;

let host: ChatHost | undefined;
let runtime: SessionRuntime | undefined;

function launchConfig(): AgentLaunchConfig {
  const config = vscode.workspace.getConfiguration("cursorAcp");
  // Empty means auto-detect (see DEFAULT_AGENT_COMMANDS); anything else is used as-is.
  const command = config.get<string>("agentPath", "").trim();
  const args = config.get<string[]>("agentArgs", []).filter((a) => typeof a === "string");
  const extraEnv = config.get<Record<string, string>>("environment", {});
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  return { command, args, env, protocolLogging: config.get<boolean>("protocolLogging", false) };
}

function workspaceInfo(): { cwd: string; name: string } | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || (folder.uri.scheme !== "file" && folder.uri.scheme !== "vscode-remote")) return undefined;
  return { cwd: folder.uri.fsPath, name: folder.name };
}

export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand("setContext", "cursorAcp.noSecondarySidebar", !supportsSecondarySidebar());
  const log = vscode.window.createOutputChannel("Cursor Agent", { log: true });
  context.subscriptions.push(log);
  const diffs = new DiffContentProvider();
  context.subscriptions.push(diffs, vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffs));

  const workspace = workspaceInfo();
  const cwd = workspace?.cwd ?? process.cwd();
  const storage = {
    getLastSessionId: () => context.workspaceState.get<string>(`cursorAcp.lastSession:${cwd}`),
    setLastSessionId: (id: string | undefined) => void context.workspaceState.update(`cursorAcp.lastSession:${cwd}`, id),
    getModelPreferences: () => context.globalState.get<ModelPreferences>("cursorAcp.modelPreferences", {}),
    setModelPreferences: (prefs: ModelPreferences) => void context.globalState.update("cursorAcp.modelPreferences", prefs),
  };

  const runtimeLogger = {
    info: (m: string) => log.info(m),
    warn: (m: string) => log.warn(m),
    error: (m: string) => log.error(m),
    protocol: (direction: "in" | "out", line: string) => log.trace(`${direction === "in" ? "←" : "→"} ${line.length > 4000 ? line.slice(0, 4000) + "…" : line}`),
    stderr: (text: string) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) log.debug(`[agent stderr] ${line}`);
    },
  };

  runtime = new SessionRuntime({
    cwd,
    workspaceName: workspace?.name ?? "(no folder)",
    ...(vscode.env.remoteName ? { remoteName: vscode.env.remoteName } : {}),
    getLaunchConfig: launchConfig,
    storage,
    log: runtimeLogger,
    events: {
      message: (message) => host?.onRuntimeMessage(message),
      permissionRequested: (title) => host?.onPermissionRequested(title),
      turnFinished: (reason) => host?.onTurnFinished(reason),
      questionAsked: (title) => host?.onQuestionAsked(title),
      // The UI shows a setup card with the probe result; no need to force the settings panel open.
      agentUnavailable: () => void host?.probe(),
    },
  });
  // Capture full before/after texts for the native diff editor.
  attachDiffCapture(runtime.model, diffs);

  host = new ChatHost(context, runtime, diffs, log);
  context.subscriptions.push(host);

  let started = false;
  const ensureStarted = () => {
    if (started || !runtime) return;
    started = true;
    if (!workspace) {
      runtime.model.addNotice("warning", "Open a folder to chat with the Cursor agent about it.", undefined, []);
      return;
    }
    const resume = vscode.workspace.getConfiguration("cursorAcp").get<boolean>("resumeLastSession", true);
    const last = resume ? storage.getLastSessionId() : undefined;
    void runtime.start(last);
  };

  for (const viewId of ALL_VIEW_IDS) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        viewId,
        {
          resolveWebviewView(view) {
            host?.attachView(view);
            ensureStarted();
          },
        },
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    );
  }

  const openPanel = () => {
    const panel = vscode.window.createWebviewPanel(PANEL_TYPE, "Cursor", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "cursor-activity.svg");
    host?.attachPanel(panel);
    ensureStarted();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorAcp.focus", () => {
      void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.newSession", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      await runtime?.newSession();
    }),
    vscode.commands.registerCommand("cursorAcp.showHistory", async () => {
      ensureStarted();
      if (!runtime) return;
      try {
        const sessions = await runtime.listSessions();
        if (sessions.length === 0) {
          void vscode.window.showInformationMessage("No previous Cursor sessions for this folder.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          sessions.map((s) => ({
            label: s.title ?? s.sessionId.slice(0, 8),
            description: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined,
            detail: s.sessionId,
            sessionId: s.sessionId,
          })),
          { placeHolder: "Resume a Cursor session", matchOnDescription: true, matchOnDetail: true },
        );
        if (picked) {
          await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
          await runtime.loadSession(picked.sessionId);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not list sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("cursorAcp.openInEditor", openPanel),
    vscode.commands.registerCommand("cursorAcp.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      host?.attachSelection(editor);
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.addFileToChat", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      ensureStarted();
      host?.send({ type: "composer.attach", attachment: { kind: "file", label: target.path.split("/").pop() ?? target.path, path: vscode.workspace.asRelativePath(target, false) } });
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.stop", () => runtime?.cancel()),
    vscode.commands.registerCommand("cursorAcp.reconnect", () => {
      ensureStarted();
      return runtime?.reconnect();
    }),
    vscode.commands.registerCommand("cursorAcp.showLogs", () => log.show(true)),
    vscode.commands.registerCommand("cursorAcp.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "cursorAcp")),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(PANEL_TYPE, {
      deserializeWebviewPanel(panel) {
        host?.attachPanel(panel);
        ensureStarted();
        return Promise.resolve();
      },
    }),
  );

  // Development aids (only active when launched with these environment variables):
  //   CURSOR_ACP_AUTO_OPEN=1            opens the view immediately after activation
  //   CURSOR_ACP_DEV_SCRIPT=<file.json> replays [{ delayMs, message }] UI messages through the host
  if (process.env.CURSOR_ACP_AUTO_OPEN === "1") {
    void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }
  const devScript = process.env.CURSOR_ACP_DEV_SCRIPT;
  if (devScript) {
    host.onFirstReady = () => {
      void (async () => {
        try {
          const steps = JSON.parse(await vscode.workspace.fs.readFile(vscode.Uri.file(devScript)).then((b) => Buffer.from(b).toString("utf8"))) as Array<{ delayMs?: number; message: WebviewToExtension }>;
          for (const step of steps) {
            await new Promise((r) => setTimeout(r, step.delayMs ?? 0));
            log.info(`[dev script] ${JSON.stringify(step.message).slice(0, 200)}`);
            await host?.handleMessage(step.message);
          }
        } catch (error) {
          log.error(`[dev script] ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    };
  }

  log.info(`Cursor Agent activated (workspace: ${cwd}${vscode.env.remoteName ? `, remote: ${vscode.env.remoteName}` : ""}).`);
}

function attachDiffCapture(model: ThreadModel, diffs: DiffContentProvider): void {
  // SessionRuntime constructs the ThreadModel, so the capture hook is registered afterwards.
  model.setDiffListener((itemId, path, oldText, newText) => diffs.remember(itemId, path, oldText, newText));
}

/**
 * Stops the agent process (SIGTERM, then SIGKILL after a short grace period).
 * `context.subscriptions` (host, diff provider, views) are disposed by VS Code.
 */
export async function deactivate(): Promise<void> {
  const current = runtime;
  runtime = undefined;
  host = undefined;
  await current?.dispose();
}
