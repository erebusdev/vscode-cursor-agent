import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCommandLine } from "../src/extension/setupCommands";

describe("loginCommandLine", () => {
  it("quotes a POSIX path with spaces", () => {
    expect(loginCommandLine("/home/me/.local/bin/agent", {}, false)).toBe("/home/me/.local/bin/agent login");
    expect(loginCommandLine("/Users/me/my tools/agent", {}, false)).toBe("'/Users/me/my tools/agent' login");
  });

  it("runs a Cursor shim through node.exe in PowerShell, with the shim's env", () => {
    const root = mkdtempSync(join(tmpdir(), "cursor-agent-"));
    mkdirSync(join(root, "versions", "2026.09.23-86fc751"), { recursive: true });
    writeFileSync(join(root, "versions", "2026.09.23-86fc751", "node.exe"), "");
    writeFileSync(join(root, "versions", "2026.09.23-86fc751", "index.js"), "");
    const shim = join(root, "agent.cmd");
    writeFileSync(shim, "");
    const line = loginCommandLine(shim, { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, true);
    expect(line.startsWith("$env:CURSOR_INVOKED_AS = 'agent.cmd'; ")).toBe(true);
    expect(line).toContain(`& '${join(root, "versions", "2026.09.23-86fc751", "node.exe")}' '${join(root, "versions", "2026.09.23-86fc751", "index.js")}' 'login'`);
  });

  it("runs an ordinary .cmd wrapper directly in PowerShell", () => {
    expect(loginCommandLine("C:\\tools\\wrap.cmd", {}, true)).toBe("& 'C:\\tools\\wrap.cmd' login");
  });
});
