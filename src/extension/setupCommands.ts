/**
 * Command lines for the guided setup steps (kept free of the vscode module so
 * they can be unit tested).
 */
import { planLaunch } from "./acp/windowsLaunch";
import { IS_WINDOWS } from "./platform";

/** Official one-liners from https://cursor.com/docs/cli/installation. */
export const INSTALL_COMMAND_POSIX = "curl https://cursor.com/install -fsS | bash";
export const INSTALL_COMMAND_WINDOWS = "irm 'https://cursor.com/install?win32=true' | iex";

export const POLL_MS = 3000;
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
export const LOGIN_TIMEOUT_MS = 15 * 60_000;

function quotePosix(arg: string): string {
  return /^[A-Za-z0-9_\/.:=+@%-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

/** Shell line that runs the agent with the given args, using the same launch rules as the session. */
export function loginCommandLine(resolvedPath: string, env: NodeJS.ProcessEnv, windows = IS_WINDOWS): string {
  const plan = planLaunch(resolvedPath, ["login"], env, windows ? "win32" : "linux");
  if (!windows) return [plan.file, ...plan.args].map(quotePosix).join(" ");
  if (plan.mode === "cmd") {
    // planLaunch produced `cmd.exe /d /s /c "..."`; in PowerShell just run the .cmd itself.
    return `& ${quotePowerShell(resolvedPath)} login`;
  }
  const extra = Object.entries(plan.env ?? {})
    .map(([k, v]) => `$env:${k} = ${quotePowerShell(v)}; `)
    .join("");
  return `${extra}& ${quotePowerShell(plan.file)} ${plan.args.map(quotePowerShell).join(" ")}`;
}

