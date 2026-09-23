/**
 * Spawns and supervises the `agent acp` child process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveExecutable } from "./resolveExecutable";

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
  private readonly exitListeners = new Set<(exit: AgentExit) => void>();

  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly resolvedCommand: string,
    readonly displayCommand: string,
  ) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    child.on("exit", (code, signal) => {
      this.exited = { code, signal, stderrTail: this.stderrTail };
      for (const listener of this.exitListeners) {
        listener(this.exited);
      }
    });
  }

  static async spawn(options: AgentSpawnOptions): Promise<AgentProcess> {
    const resolved = await resolveExecutable(options.command, options.env);
    if (!resolved) {
      throw new AgentProcessError(
        `Cursor Agent executable not found: "${options.command}".`,
        "Set `cursorAcp.agentPath` to the full path of the `agent` CLI (or a wrapper script), e.g. /Users/me/.local/bin/agent.",
      );
    }
    const displayCommand = [resolved, ...options.args].join(" ");
    const child = spawn(resolved, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // The wrapper scripts are plain sh; no shell needed, and avoiding one keeps argv intact.
      shell: false,
      windowsHide: true,
    });
    const process = new AgentProcess(child, resolved, displayCommand);
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
              : "Check `cursorAcp.agentPath` and that the Cursor Agent CLI is installed on this machine.",
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

  get exit(): AgentExit | undefined {
    return this.exited;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  onExit(listener: (exit: AgentExit) => void): () => void {
    if (this.exited) {
      listener(this.exited);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Graceful stop: close stdin, SIGTERM, then SIGKILL after a grace period. */
  async kill(graceMs = 1500): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, graceMs);
      this.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
