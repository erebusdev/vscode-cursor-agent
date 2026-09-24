import * as vscode from "vscode";
import { ChatHost } from "./ChatHost";
import { AGENT_PATH_KEY } from "./platform";
import { DEFAULT_SAFE_LIST } from "./session/approvals";
import type { ApprovalPolicy } from "../shared/protocol";
import { DIFF_SCHEME, DiffContentProvider } from "./DiffContentProvider";
import { SessionRuntime, type AgentLaunchConfig, type SessionMeta } from "./session/SessionRuntime";
import { ThreadModel } from "./session/ThreadModel";
import type { WebviewToExtension } from "../shared/protocol";
import { hostEnv, prepareHostEnv } from "./hostEnv";
import { describeMcpServers, loadMcpServers, type McpServerSpec } from "./session/mcpConfig";
import { resolveAgentExecutable } from "./acp/resolveExecutable";
import { planLaunch } from "./acp/windowsLaunch";
import { execFile } from "node:child_process";

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
  // Windows hosts read their own key so a Windows path never leaks into WSL/SSH windows.
  const command = config.get<string>(AGENT_PATH_KEY, "").trim();
  const args = config.get<string[]>("agentArgs", []).filter((a) => typeof a === "string");
  const env = hostEnv(config.get<Record<string, string>>("environment", {}));
  return { command, args, env, protocolLogging: config.get<boolean>("protocolLogging", false) };
}

/** The MCP servers to hand to the agent with each session; see mcpConfig.ts. */
async function mcpServers(cwd: string | undefined, log: { warn(m: string): void }): Promise<ReturnType<typeof loadMcpServers> extends Promise<infer R> ? R : never> {
  const config = vscode.workspace.getConfiguration("cursorAcp");
  const forwardProject = config.get<boolean>("mcpForwardProjectServers", true);
  const userConfigPath = config.get<string>("mcpUserConfig", "").trim();
  const trusted = vscode.workspace.isTrusted;
  if (forwardProject && cwd && !trusted) log.warn("Workspace is not trusted; its .cursor/mcp.json servers are not forwarded to the agent.");
  const result = await loadMcpServers({
    ...(forwardProject && cwd && trusted ? { projectDir: cwd } : {}),
    ...(userConfigPath ? { userConfigPath } : {}),
    env: launchConfig().env,
  });
  for (const source of result.sources) if (source.error) log.warn(`MCP config ${source.path}: ${source.error}`);
  return result;
}

/** ACP wire form of a server spec (stdio keeps Cursor's optional cwd). */
function toAcpServer(spec: McpServerSpec): import("@agentclientprotocol/sdk").McpServer {
  if ("url" in spec) return { type: spec.type, name: spec.name, url: spec.url, headers: [...spec.headers] };
  const stdio = { name: spec.name, command: spec.command, args: [...spec.args], env: [...spec.env], ...(spec.cwd ? { cwd: spec.cwd } : {}) };
  return stdio as import("@agentclientprotocol/sdk").McpServer;
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
    getSessionMeta: () => context.globalState.get<SessionMeta>("cursorAcp.sessionMeta", { titles: {}, hidden: [] }),
    setSessionMeta: (meta: SessionMeta) => void context.globalState.update("cursorAcp.sessionMeta", meta),
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
    getModelDefaults: () => {
      const config = vscode.workspace.getConfiguration("cursorAcp");
      const modelId = config.get<string>("defaultModel", "").trim();
      return { ...(modelId ? { modelId } : {}), options: config.get<Record<string, string | boolean>>("defaultModelOptions", {}) };
    },
    getApprovalConfig: () => {
      const config = vscode.workspace.getConfiguration("cursorAcp");
      return { policy: config.get<ApprovalPolicy>("approvalPolicy", "safe"), safeList: config.get<string[]>("safeList", [...DEFAULT_SAFE_LIST]) };
    },
    getMcpServers: async () => (await mcpServers(workspace?.cwd, log)).servers.map(toAcpServer),
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

  const envReady = prepareHostEnv(log);
  let started = false;
  const ensureStarted = async () => {
    if (started || !runtime) return;
    started = true;
    // The login-shell PATH lookup is bounded (5 s); the agent and its MCP servers need it.
    await envReady;
    if (!runtime) return;
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
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "media", "cursor-light.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "media", "cursor-dark.svg"),
    };
    host?.attachPanel(panel);
    ensureStarted();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("cursorAcp.focus", () => {
      void vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      host?.focusComposer();
    }),
    vscode.commands.registerCommand("cursorAcp.cycleApprovals", () => {
      if (!runtime) return;
      const order = ["ask", "safe", "auto"] as const;
      const current = runtime.state.approvalPolicy ?? "safe";
      const next = order[(order.indexOf(current) + 1) % order.length]!;
      runtime.setApprovalPolicy(next);
      void vscode.window.setStatusBarMessage(`Cursor approvals: ${next === "safe" ? "Safe list" : next === "auto" ? "Auto" : "Ask"}`, 2000);
    }),
    vscode.commands.registerCommand("cursorAcp.copySessionId", async () => {
      const id = runtime?.state.sessionId;
      if (!id) {
        void vscode.window.showInformationMessage("No Cursor session is open in this window yet.");
        return;
      }
      await vscode.env.clipboard.writeText(id);
      void vscode.window.setStatusBarMessage(`Copied Cursor session id ${id}`, 3000);
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
    vscode.commands.registerCommand("cursorAcp.showMcpServers", async () => {
      await envReady;
      const lines: string[] = ["MCP servers"];
      const result = await mcpServers(workspace?.cwd, log);
      const described = describeMcpServers(result);
      lines.push("Forwarded to the agent by the extension:", ...(described.length ? described.map((l) => `  ${l}`) : ["  (none: no mcp.json found, or forwarding is off)"]));
      const launch = launchConfig();
      const found = await resolveAgentExecutable(launch.command, launch.env);
      if (!found) {
        lines.push("Reported by the CLI: agent executable not found.");
      } else {
        const plan = planLaunch(found.path, [...launch.args, "mcp", "list"], launch.env);
        const output = await new Promise<string>((resolve) => {
          const child = execFile(plan.file, [...plan.args], { cwd: workspace?.cwd ?? process.cwd(), env: plan.env ? { ...launch.env, ...plan.env } : launch.env, timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false }, (error, stdout, stderr) => {
            resolve(error && !stdout ? `could not run "${found.path} mcp list": ${error.message}${stderr ? `\n${stderr}` : ""}` : `${stdout}${stderr}`.trim());
          });
          child.stdin?.end();
        });
        const forwarded = new Set(result.servers.map((s) => s.name));
        lines.push(`Reported by the CLI (${found.path} mcp list):`);
        for (const line of output.split(/\r?\n/).filter((l) => l.trim())) {
          const name = /^\s*([^:]+):/.exec(line)?.[1]?.trim();
          lines.push(`  ${line}${name && forwarded.has(name) && /needs approval/i.test(line) ? "  (forwarded by the extension, so it is available in chat)" : ""}`);
        }
      }
      log.info(lines.join("\n"));
      log.show(true);
    }),
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
