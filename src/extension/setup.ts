/**
 * Guided setup steps: installing the Cursor Agent CLI and logging in.
 *
 * Both run Cursor's own commands in a visible VS Code terminal (never silently
 * inside the extension), on whichever machine hosts the extension, so Remote
 * SSH and WSL windows install on the right side. After starting a step the
 * host polls for the expected outcome (the executable appearing, the auth
 * file being written) and reports back so the UI can reconnect.
 */
import * as vscode from "vscode";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentExecutable } from "./acp/resolveExecutable";
import { IS_WINDOWS } from "./platform";
import { resolveCursorConfigDir } from "./session/usage";
import { INSTALL_COMMAND_POSIX, INSTALL_COMMAND_WINDOWS, INSTALL_TIMEOUT_MS, LOGIN_TIMEOUT_MS, POLL_MS, agentCommandLine, loginCommandLine } from "./setupCommands";

export type SetupPhase = "idle" | "installing" | "loggingIn";

export interface SetupStatus {
  readonly phase: SetupPhase;
  readonly text?: string;
}

export interface SetupOptions {
  /** Configured agent path (may be empty for auto-detect). */
  readonly configuredPath: string;
  readonly configDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onStatus: (status: SetupStatus) => void;
  /** Called when the step's outcome is observed (executable found / auth written). */
  readonly onReady: () => void;
  readonly log: (message: string) => void;
}

class Watcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private closeSub: vscode.Disposable | undefined;
  private done = false;

  constructor(
    private readonly terminal: vscode.Terminal,
    private readonly check: () => Promise<boolean>,
    timeoutMs: number,
    private readonly onSuccess: () => void,
    private readonly onGiveUp: (reason: string) => void,
  ) {
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.deadline = setTimeout(() => this.finish(false, "Timed out waiting for the step to complete."), timeoutMs);
    // When the terminal closes, do one last check and then stop watching either way.
    this.closeSub = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) void this.tick(true);
    });
  }

  private async tick(final = false): Promise<void> {
    if (this.done) return;
    let ok = false;
    try {
      ok = await this.check();
    } catch {
      ok = false;
    }
    if (ok) this.finish(true);
    else if (final) this.finish(false, "The terminal was closed before the step completed.");
  }

  private finish(success: boolean, reason = ""): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    if (this.deadline) clearTimeout(this.deadline);
    this.closeSub?.dispose();
    if (success) this.onSuccess();
    else this.onGiveUp(reason);
  }

  cancel(): void {
    this.finish(false, "cancelled");
  }
}

export interface McpLoginOptions {
  readonly configuredPath: string;
  /** The configured `agentArgs`, passed before `mcp login` like before `acp`. */
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  /** Sign-ins are saved per project folder, so this must be the workspace folder. */
  readonly cwd: string | undefined;
  readonly id: string;
  readonly onClosed: () => void;
  readonly log: (message: string) => void;
}

function createShellTerminal(name: string, cwd?: string): vscode.Terminal {
  return vscode.window.createTerminal({
    name,
    ...(cwd ? { cwd } : {}),
    // The Windows commands are PowerShell lines; everywhere else the default shell is fine.
    ...(IS_WINDOWS ? { shellPath: "powershell.exe", shellArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"] } : {}),
  });
}

export class SetupController implements vscode.Disposable {
  private watcher: Watcher | undefined;
  private terminal: vscode.Terminal | undefined;
  private readonly mcpTerminals = new Map<vscode.Terminal, vscode.Disposable>();

  dispose(): void {
    this.watcher?.cancel();
    this.watcher = undefined;
    for (const sub of this.mcpTerminals.values()) sub.dispose();
    this.mcpTerminals.clear();
  }

  private openTerminal(name: string): vscode.Terminal {
    this.terminal?.dispose();
    const terminal = createShellTerminal(name);
    this.terminal = terminal;
    terminal.show(true);
    return terminal;
  }

  /**
   * Runs `agent mcp login <id>` in a terminal in the workspace folder (Cursor
   * opens the browser and waits on localhost); `onClosed` runs when the
   * terminal is closed. Returns an error text when the CLI cannot be found.
   */
  async mcpLogin(options: McpLoginOptions): Promise<string | undefined> {
    const found = await resolveAgentExecutable(options.configuredPath, options.env);
    if (!found) return "The Cursor Agent CLI could not be found, so the sign-in cannot start.";
    const command = agentCommandLine(found.path, [...options.args, "mcp", "login", options.id], options.env);
    const terminal = createShellTerminal(`Sign in: ${options.id}`, options.cwd);
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) return;
      sub.dispose();
      this.mcpTerminals.delete(terminal);
      options.onClosed();
    });
    this.mcpTerminals.set(terminal, sub);
    options.log(`Running MCP sign-in in terminal (cwd ${options.cwd ?? "default"}): ${command}`);
    terminal.show(false);
    terminal.sendText(command, true);
    return undefined;
  }

  /** Runs Cursor's installer in a terminal and reconnects once the executable resolves. */
  install(options: SetupOptions): void {
    this.watcher?.cancel();
    const command = IS_WINDOWS ? INSTALL_COMMAND_WINDOWS : INSTALL_COMMAND_POSIX;
    const terminal = this.openTerminal("Cursor Agent install");
    options.log(`Running installer in terminal: ${command}`);
    terminal.sendText(command, true);
    options.onStatus({ phase: "installing", text: "Running Cursor's installer in the terminal…" });
    this.watcher = new Watcher(
      terminal,
      async () => (await resolveAgentExecutable(options.configuredPath, options.env)) !== undefined,
      INSTALL_TIMEOUT_MS,
      () => {
        options.onStatus({ phase: "idle" });
        options.onReady();
      },
      (reason) => {
        options.log(`Install step ended without finding the CLI: ${reason}`);
        options.onStatus({ phase: "idle", text: reason === "cancelled" ? undefined : "The CLI still could not be found. Check the terminal output, or set the path below." });
      },
    );
  }

  /** Runs `agent login` in a terminal and reconnects once the auth file is written. */
  async login(options: SetupOptions): Promise<void> {
    this.watcher?.cancel();
    const found = await resolveAgentExecutable(options.configuredPath, options.env);
    if (!found) {
      options.onStatus({ phase: "idle", text: "The Cursor Agent CLI could not be found, so login cannot start. Install it first." });
      return;
    }
    const configDir = await resolveCursorConfigDir({ configDir: options.configDir, agentPath: found.path, env: options.env });
    const authFile = join(configDir, "auth.json");
    const startedAt = Date.now();
    const command = loginCommandLine(found.path, options.env);
    const terminal = this.openTerminal("Cursor Agent login");
    options.log(`Running login in terminal: ${command} (watching ${authFile})`);
    terminal.sendText(command, true);
    options.onStatus({ phase: "loggingIn", text: "Complete the sign-in in your browser; the terminal shows the link if it did not open." });
    this.watcher = new Watcher(
      terminal,
      async () => {
        if (!existsSync(authFile)) return false;
        try {
          return statSync(authFile).mtimeMs >= startedAt - 1000;
        } catch {
          return false;
        }
      },
      LOGIN_TIMEOUT_MS,
      () => {
        options.onStatus({ phase: "idle" });
        options.onReady();
      },
      (reason) => {
        options.log(`Login step ended without a new auth file: ${reason}`);
        options.onStatus({ phase: "idle", text: reason === "cancelled" ? undefined : "No login was detected. Finish the sign-in in the terminal, then press Connect." });
      },
    );
  }
}
