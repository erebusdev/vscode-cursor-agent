import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCursorShimTarget, planLaunch } from "../src/extension/acp/windowsLaunch";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function cursorInstall(versions: string[], withNode = true) {
  const root = mkdtempSync(join(tmpdir(), "cursor-agent-"));
  dirs.push(root);
  const shim = join(root, "agent.cmd");
  writeFileSync(shim, "@echo off\r\n");
  for (const v of versions) {
    mkdirSync(join(root, "versions", v), { recursive: true });
    if (withNode) writeFileSync(join(root, "versions", v, "node.exe"), "");
    writeFileSync(join(root, "versions", v, "index.js"), "");
  }
  return { root, shim };
}

describe("planLaunch", () => {
  it("runs the resolved path directly on non-Windows hosts", () => {
    const plan = planLaunch("/home/me/.local/bin/agent", ["acp"], {}, "linux");
    expect(plan).toEqual({ file: "/home/me/.local/bin/agent", args: ["acp"], mode: "direct" });
  });

  it("launches a Cursor shim's newest node.exe + index.js directly", () => {
    const { root, shim } = cursorInstall(["2026.09.01-aaaaaaa", "2026.09.23-86fc751", "2026.9.5-bbbbbbb", "not-a-version"]);
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    const plan = planLaunch(shim, ["acp"], env, "win32");
    expect(plan.mode).toBe("cursor-shim");
    expect(plan.file).toBe(join(root, "versions", "2026.09.23-86fc751", "node.exe"));
    expect(plan.args).toEqual([join(root, "versions", "2026.09.23-86fc751", "index.js"), "acp"]);
    expect(plan.env).toEqual({ CURSOR_INVOKED_AS: "agent.cmd", NODE_COMPILE_CACHE: join("C:\\Users\\me\\AppData\\Local", "cursor-compile-cache") });
  });

  it("understands the newer timestamped version directory names", () => {
    const { root, shim } = cursorInstall(["2026.09.23-86fc751", "2026.09.24-10-11-12-c0ffee1"]);
    expect(findCursorShimTarget(shim)?.node).toBe(join(root, "versions", "2026.09.24-10-11-12-c0ffee1", "node.exe"));
  });

  it("skips version directories that lack node.exe", () => {
    const { root, shim } = cursorInstall(["2026.09.23-86fc751"], false);
    mkdirSync(join(root, "versions", "2026.09.01-aaaaaaa"));
    writeFileSync(join(root, "versions", "2026.09.01-aaaaaaa", "node.exe"), "");
    writeFileSync(join(root, "versions", "2026.09.01-aaaaaaa", "index.js"), "");
    expect(findCursorShimTarget(shim)?.version).toBe("2026.09.01-aaaaaaa");
  });

  it("falls back to cmd.exe for an ordinary .cmd wrapper, quoting as needed", () => {
    const dir = mkdtempSync(join(tmpdir(), "wrap-"));
    dirs.push(dir);
    const wrapper = join(dir, "my wrapper.cmd");
    writeFileSync(wrapper, "@echo off\r\n");
    const plan = planLaunch(wrapper, ["acp", "-e", "https://x"], { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
    expect(plan.mode).toBe("cmd");
    expect(plan.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.windowsVerbatimArguments).toBe(true);
    expect(plan.args).toEqual(["/d", "/s", "/c", `""${wrapper}" acp -e https://x"`]);
  });

  it("runs a .ps1 wrapper through powershell", () => {
    const plan = planLaunch("C:\\tools\\agent.ps1", ["acp"], { SystemRoot: "C:\\Windows" }, "win32");
    expect(plan.mode).toBe("powershell");
    expect(plan.file).toBe(join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    expect(plan.args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\tools\\agent.ps1", "acp"]);
  });

  it("runs a real .exe directly on Windows", () => {
    expect(planLaunch("C:\\tools\\agent.exe", ["acp"], {}, "win32").mode).toBe("direct");
  });
});
