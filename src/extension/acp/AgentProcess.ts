/**
 * Spawns and supervises the `agent acp` child process.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AGENT_PATH_KEY, IS_WINDOWS } from "../platform";
import { describeDefaultAgentCommands, resolveAgentExecutable } from "./resolveExecutable";
import { planLaunch, type LaunchPlan } from "./windowsLaunch";

export interface AgentSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onStderr?: (text: string) => void;
}

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
}

const STDERR_TAIL_LIMIT = 16 * 1024;

export class AgentProcessError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "AgentProcessError";
  }
}

export class AgentProcess {
  private stderrTail = "";
  private exited: AgentExit | undefined;
  private exitListeners = new Set<(exit: AgentExit) => void>();

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly resolvedCommand: string,
    readonly displayCommand: string,
    readonly plan: LaunchPlan,
  ) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    // Writing to stdin after the child died surfaces as an asynchronous 'error' event on the
    // stream (EPIPE / ERR_STREAM_DESTROYED), never as a synchronous throw. Without a listener
    // that event would crash the extension host, so every stdio stream gets a sink here; the
    // JSON-RPC peer adds its own (informative) listeners on top.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", () => undefined);
    }
    child.on("exit", (code, signal) => {
      this.exited = { code, signal, stderrTail: this.stderrTail };
      const listeners = this.exitListeners;
      this.exitListeners = new Set();
      for (const listener of listeners) {
        try {
          listener(this.exited);
        } catch {
          // A misbehaving listener must not stop the others from running.
        }
      }
    });
  }

  static async spawn(options: AgentSpawnOptions): Promise<AgentProcess> {
    const found = await resolveAgentExecutable(options.command, options.env);
    if (!found) {
      throw new AgentProcessError(
        options.command.trim() ? `Cursor Agent executable not found: "${options.command.trim()}".` : `Cursor Agent CLI not found (looked for ${describeDefaultAgentCommands()}).`,
        IS_WINDOWS
          ? `Install the Cursor Agent CLI (irm 'https://cursor.com/install?win32=true' | iex), or set \`cursorAcp.${AGENT_PATH_KEY}\` to the full path of agent.cmd, e.g. %LOCALAPPDATA%\\cursor-agent\\agent.cmd.`
          : "Install the Cursor Agent CLI, or set `cursorAcp.agentPath` to the full path of the `agent` CLI (or a wrapper script), e.g. /Users/me/.local/bin/agent.",
      );
    }
    const resolved = found.path;
    const displayCommand = [resolved, ...options.args].join(" ");
    const plan = planLaunch(resolved, options.args, options.env);
    const child = spawn(plan.file, [...plan.args], {
      cwd: options.cwd,
      env: plan.env ? { ...options.env, ...plan.env } : options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Never a shell: on POSIX the wrappers are plain sh scripts, and on Windows the plan
      // already names the interpreter explicitly (see windowsLaunch.ts).
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
    });
    const process = new AgentProcess(child, resolved, displayCommand, plan);
    if (options.onStderr) {
      child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
    }
    // Surface spawn failures (ENOENT/EACCES) as a rejected promise instead of an unhandled 'error'.
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: NodeJS.ErrnoException) => {
        child.off("spawn", onSpawn);
        reject(
          new AgentProcessError(
            `Failed to launch "${displayCommand}": ${error.message}`,
            error.code === "EACCES"
              ? "The file is not executable. Check its permissions (chmod +x)."
              : `Check \`cursorAcp.${AGENT_PATH_KEY}\` and that the Cursor Agent CLI is installed on this machine.`,
          ),
        );
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    // Late errors (e.g. EPIPE) must not crash the extension host.
    child.on("error", () => undefined);
    return process;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private killTreeWindows(pid: number, graceMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dispose();
        resolve();
      };
      const dispose = this.onExit(finish);
      const timer = setTimeout(() => {
        // taskkill did not report an exit in time; fall back to Node's TerminateProcess.
        try {
          this.child.kill();
        } catch {
          // ignore
        }
        setTimeout(finish, 500);
      }, graceMs);
      execFile("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }, () => {
        // Exit is observed through the 'exit' event; errors here (already gone) are fine.
      });
    });
  }

  get exit(): AgentExit | undefined {
    return this.exited;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  /** Registers an exit listener (invoked immediately if the process already exited). Returns a disposer. */
  onExit(listener: (exit: AgentExit) => void): () => void {
    if (this.exited) {
      listener(this.exited);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Graceful stop: close stdin, SIGTERM, then SIGKILL after a grace period.
   * Always resolves within `graceMs` (plus a short SIGKILL wait), even if the
   * child never reports an exit, so shutdown cannot hang on a stuck agent.
   *
   * On Windows there are no signals and the agent may be a tree
   * (cmd.exe → powershell.exe → node.exe), so `taskkill /t /f` is used
   * instead; it takes the whole tree down in one go.
   */
  async kill(graceMs = 1500): Promise<void> {
    if (this.exited) return;
    const child = this.child;
    // Spawn failed or the process is already gone: nothing to wait for.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (!child.stdin.destroyed) child.stdin.end();
    } catch {
      // ignore
    }
    if (IS_WINDOWS) {
      await this.killTreeWindows(child.pid, graceMs);
      return;
    }
    let signalled = false;
    try {
      signalled = child.kill("SIGTERM");
    } catch {
      // ignore
    }
    if (!signalled) return;
    await new Promise<void>((resolve) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const termTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        // Give the kernel a moment to deliver the exit; never wait indefinitely.
        killTimer = setTimeout(finish, 500);
      }, graceMs);
      const dispose = this.onExit(finish);
      function finish(): void {
        clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
        dispose();
        resolve();
      }
    });
  }
}
