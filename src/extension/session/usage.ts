/**
 * Reads Cursor plan usage for the logged-in CLI account.
 *
 * Mirrors T3 Code's `cursorUsageLimits`: the CLI stores `auth.json` with an
 * access token in its config directory; the dashboard RPC
 * `DashboardService/GetCurrentPeriodUsage` returns percentages for the
 * current billing cycle. Read-only.
 */
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSummary, UsageWindow } from "../../shared/protocol";

export interface UsageSourceOptions {
  /** Explicit config dir from settings, if any. */
  readonly configDir?: string;
  /** Executable/wrapper path; shell wrappers that export CURSOR_CONFIG_DIR are sniffed. */
  readonly agentPath?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  return path.replace(/^~(?=$|\/)/, home).replace(/\$HOME\b|\$\{HOME\}/g, home);
}

/** Best-effort discovery of the CLI config dir (where auth.json lives). */
export async function resolveCursorConfigDir(options: UsageSourceOptions): Promise<string> {
  const { env } = options;
  if (options.configDir?.trim()) return expandHome(options.configDir.trim(), env);
  if (env.CURSOR_CONFIG_DIR?.trim()) return expandHome(env.CURSOR_CONFIG_DIR.trim(), env);
  if (options.agentPath) {
    const text = await readScriptHead(options.agentPath);
    if (text?.startsWith("#!")) {
      const match = /CURSOR_CONFIG_DIR=["']?([^"'\n]+)["']?/.exec(text);
      if (match?.[1]) return expandHome(match[1].trim(), env);
    }
  }
  if (process.platform === "win32") {
    return join(env.APPDATA || join(env.USERPROFILE || homedir(), "AppData", "Roaming"), "Cursor");
  }
  if (process.platform === "darwin") return join(env.HOME || homedir(), ".cursor");
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "cursor");
}

const SCRIPT_HEAD_BYTES = 64 * 1024;

/**
 * Reads at most the first 64KB of the configured executable. The real agent
 * is a large native binary; reading it whole on every usage refresh would be
 * wasteful, and a wrapper script's exports are near the top anyway.
 */
async function readScriptHead(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(SCRIPT_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SCRIPT_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined; // missing / unreadable – fall through to the defaults
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface RawUsage {
  billingCycleStart?: string | number;
  billingCycleEnd?: string | number;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
    remainingBonus?: boolean;
    bonusTooltip?: string;
  };
  spendLimitUsage?: { totalSpend?: number; individualUsed?: number; pooledUsed?: number; limitType?: string };
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  autoBucketModels?: unknown;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function mapUsage(raw: RawUsage, checkedAt: number): UsageSummary {
  const windows: UsageWindow[] = [];
  const plan = raw.planUsage;
  if (plan) {
    for (const [key, label] of [
      ["totalPercentUsed", "Included"],
      ["autoPercentUsed", "Auto models"],
      ["apiPercentUsed", "Named models"],
    ] as const) {
      const value = plan[key];
      if (typeof value === "number" && Number.isFinite(value)) windows.push({ id: key, label, usedPercent: clamp(value) });
    }
  }
  const iso = (v: string | number | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : undefined;
  };
  const resetsAt = iso(raw.billingCycleEnd);
  const cycleStartsAt = iso(raw.billingCycleStart);
  const cents = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) ? n / 100 : undefined);
  const team = raw.spendLimitUsage;
  const teamSpend = team
    ? {
        ...(cents(team.totalSpend) !== undefined ? { totalUsd: cents(team.totalSpend)! } : {}),
        ...(cents(team.individualUsed) !== undefined ? { individualUsd: cents(team.individualUsed)! } : {}),
        ...(cents(team.pooledUsed) !== undefined ? { pooledUsd: cents(team.pooledUsed)! } : {}),
        ...(typeof team.limitType === "string" ? { limitType: team.limitType } : {}),
      }
    : undefined;
  const autoModels = Array.isArray(raw.autoBucketModels) ? raw.autoBucketModels.filter((m): m is string => typeof m === "string") : [];
  return {
    checkedAt,
    windows,
    ...(resetsAt ? { resetsAt } : {}),
    ...(cycleStartsAt ? { cycleStartsAt } : {}),
    ...(raw.displayMessage ? { message: raw.displayMessage } : {}),
    ...(raw.autoModelSelectedDisplayMessage ? { autoMessage: raw.autoModelSelectedDisplayMessage } : {}),
    ...(raw.namedModelSelectedDisplayMessage ? { namedMessage: raw.namedModelSelectedDisplayMessage } : {}),
    ...(cents(plan?.totalSpend) !== undefined ? { spendUsd: cents(plan?.totalSpend)! } : {}),
    ...(cents(plan?.limit) !== undefined ? { limitUsd: cents(plan?.limit)! } : {}),
    ...(cents(plan?.bonusSpend) !== undefined ? { bonusUsd: cents(plan?.bonusSpend)! } : {}),
    ...(cents(plan?.includedSpend) !== undefined ? { includedSpendUsd: cents(plan?.includedSpend)! } : {}),
    ...(typeof plan?.remainingBonus === "boolean" ? { bonusRemaining: plan.remainingBonus } : {}),
    ...(plan?.bonusTooltip ? { bonusNote: plan.bonusTooltip } : {}),
    ...(teamSpend && Object.keys(teamSpend).length > 0 ? { teamSpend } : {}),
    ...(autoModels.length > 0 ? { autoModels } : {}),
  };
}

export async function fetchCursorUsage(options: UsageSourceOptions): Promise<UsageSummary> {
  const checkedAt = Date.now();
  const configDir = await resolveCursorConfigDir(options);
  let token = options.env.CURSOR_AUTH_TOKEN?.trim();
  if (!token) {
    let text: string;
    try {
      text = await readFile(join(configDir, "auth.json"), "utf8");
    } catch {
      return { checkedAt, windows: [], error: `No Cursor login found in ${configDir}. Run \`agent login\` or set cursorAcp.configDir.` };
    }
    try {
      const parsed = JSON.parse(text) as { accessToken?: string };
      token = parsed.accessToken?.trim();
    } catch {
      return { checkedAt, windows: [], error: `Could not parse ${join(configDir, "auth.json")}.` };
    }
  }
  if (!token) return { checkedAt, windows: [], error: "The Cursor login has no access token." };
  const endpoint = (options.endpoint?.trim() || options.env.CURSOR_API_ENDPOINT?.trim() || "https://api2.cursor.sh").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await doFetch(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "connect-protocol-version": "1",
        "x-cursor-client-type": "cli",
        "content-type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { checkedAt, windows: [], error: `Cursor usage request failed (${response.status}).` };
    }
    const raw = (await response.json()) as RawUsage;
    return mapUsage(raw, checkedAt);
  } catch (error) {
    return { checkedAt, windows: [], error: `Could not reach Cursor: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
