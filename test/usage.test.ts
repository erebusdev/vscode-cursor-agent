import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCursorUsage, mapUsage, resolveCursorConfigDir } from "../src/extension/session/usage";

describe("usage", () => {
  it("maps the dashboard response into windows and dollars", () => {
    const usage = mapUsage(
      {
        billingCycleStart: "1787762601000",
        billingCycleEnd: "1790441001000",
        planUsage: { totalSpend: 111872, includedSpend: 2000, limit: 2000, bonusSpend: 109872, remainingBonus: false, bonusTooltip: "Free usage beyond what you've purchased.", autoPercentUsed: 87.05, apiPercentUsed: 100, totalPercentUsed: 89.4976 },
        spendLimitUsage: { totalSpend: 503080, pooledUsed: 503080, individualUsed: 125039, limitType: "team" },
        displayMessage: "You've hit your usage limit",
        autoBucketModels: ["default", "composer-2", 42],
      },
      1,
    );
    expect(usage.windows.map((w) => [w.id, Math.round(w.usedPercent)])).toEqual([["totalPercentUsed", 89], ["autoPercentUsed", 87], ["apiPercentUsed", 100]]);
    expect(usage.resetsAt).toBe(new Date(1790441001000).toISOString());
    expect(usage.spendUsd).toBe(1118.72);
    expect(usage.limitUsd).toBe(20);
    expect(usage.message).toBe("You've hit your usage limit");
    expect(usage.cycleStartsAt).toBe(new Date(1787762601000).toISOString());
    expect(usage.includedSpendUsd).toBe(20);
    expect(usage.bonusRemaining).toBe(false);
    expect(usage.bonusNote).toBe("Free usage beyond what you've purchased.");
    expect(usage.teamSpend).toEqual({ totalUsd: 5030.8, pooledUsd: 5030.8, individualUsd: 1250.39, limitType: "team" });
    expect(usage.autoModels).toEqual(["default", "composer-2"]);
  });

  it("omits optional detail fields the dashboard does not report", () => {
    const usage = mapUsage({ planUsage: { totalPercentUsed: 5 } }, 1);
    expect(usage.windows).toEqual([{ id: "totalPercentUsed", label: "Included", usedPercent: 5 }]);
    expect(usage.cycleStartsAt).toBeUndefined();
    expect(usage.teamSpend).toBeUndefined();
    expect(usage.autoModels).toBeUndefined();
    expect(usage.bonusRemaining).toBeUndefined();
  });

  it("sniffs CURSOR_CONFIG_DIR from a wrapper script", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const wrapper = join(dir, "cursor-x");
    writeFileSync(wrapper, '#!/bin/sh\nexport CURSOR_CONFIG_DIR="$HOME/.local/share/x/state"\nexec agent "$@"\n');
    const resolved = await resolveCursorConfigDir({ agentPath: wrapper, env: { HOME: "/home/me" } });
    expect(resolved).toBe("/home/me/.local/share/x/state");
    const explicit = await resolveCursorConfigDir({ configDir: "~/cfg", agentPath: wrapper, env: { HOME: "/home/me" } });
    expect(explicit).toBe("/home/me/cfg");
  });

  it("reads auth.json and posts to the dashboard endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ accessToken: "tok" }));
    let seen: { url: string; auth: string | undefined } | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: (init?.headers as Record<string, string>)?.authorization };
      return new Response(JSON.stringify({ planUsage: { totalPercentUsed: 12 } }), { status: 200 });
    }) as typeof fetch;
    const usage = await fetchCursorUsage({ configDir: dir, env: {}, fetchImpl });
    expect(seen?.url).toBe("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
    expect(seen?.auth).toBe("Bearer tok");
    expect(usage.windows[0]?.usedPercent).toBe(12);
    const missing = await fetchCursorUsage({ configDir: join(dir, "nope"), env: {}, fetchImpl });
    expect(missing.error).toContain("No Cursor login");
  });
});
