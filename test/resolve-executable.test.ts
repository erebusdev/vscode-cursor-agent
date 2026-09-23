import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLoginShellPathCache, resolveAgentExecutable, resolveExecutable } from "../src/extension/acp/resolveExecutable";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetLoginShellPathCache();
});

function makeFixture(shellBody: string) {
  const dir = mkdtempSync(join(tmpdir(), "resolve-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const name = `acp-test-agent-${process.pid}`;
  const agent = join(bin, name);
  writeFileSync(agent, "#!/bin/sh\nexit 0\n");
  chmodSync(agent, 0o755);
  const shell = join(dir, "fake-shell");
  writeFileSync(shell, shellBody);
  chmodSync(shell, 0o755);
  return { bin, name, agent, shell, empty: join(dir, "empty") };
}

describe.skipIf(process.platform === "win32")("resolveExecutable", () => {
  it("finds the executable through a noisy interactive login shell", async () => {
    const { bin, name, agent, shell, empty } = makeFixture(
      '#!/bin/sh\necho "Welcome to the fake shell"\nprintf "user@host:~$ "\nPATH="$FAKE_BIN:$PATH"\neval "$2"\necho "trailing output from .zlogout"\n',
    );
    mkdirSync(empty);
    const env = { SHELL: shell, PATH: empty, FAKE_BIN: bin };
    expect(await resolveExecutable(name, env)).toBe(agent);
    // Cached per (shell, PATH): the same environment resolves without re-probing, a different PATH re-probes.
    expect(await resolveExecutable(name, env)).toBe(agent);
    expect(await resolveExecutable(name, { ...env, PATH: bin })).toBe(agent);
  });

  it("returns undefined when the login shell prints no PATH marker", async () => {
    const { name, shell, empty } = makeFixture('#!/bin/sh\necho "no path here"\nexit 0\n');
    mkdirSync(empty);
    expect(await resolveExecutable(name, { SHELL: shell, PATH: empty })).toBeUndefined();
  });

  it("resolves explicit and ~-prefixed paths directly", async () => {
    const { agent, name } = makeFixture("#!/bin/sh\nexit 1\n");
    expect(await resolveExecutable(agent, { PATH: "" })).toBe(agent);
    expect(await resolveExecutable(join("/definitely/missing", name), { PATH: "" })).toBeUndefined();
    expect(await resolveExecutable("   ", { PATH: "" })).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("resolveAgentExecutable", () => {
  it("prefers a configured value and otherwise tries agent then cursor-agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-agent-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const make = (name: string) => {
      const p = join(bin, name);
      writeFileSync(p, "#!/bin/sh\nexit 0\n");
      chmodSync(p, 0o755);
      return p;
    };
    // Fake login shell that prints nothing, so the real login PATH cannot leak in.
    const shell = join(dir, "fake-shell");
    writeFileSync(shell, "#!/bin/sh\nexit 0\n");
    chmodSync(shell, 0o755);
    const env = { PATH: bin, HOME: dir, SHELL: shell };
    const cursorAgent = make("cursor-agent");
    expect(await resolveAgentExecutable("", env)).toEqual({ command: "cursor-agent", path: cursorAgent });
    const agent = make("agent");
    expect(await resolveAgentExecutable("", env)).toEqual({ command: "agent", path: agent });
    const custom = make("my-wrapper");
    expect(await resolveAgentExecutable(custom, env)).toEqual({ command: custom, path: custom });
    // A configured value that does not exist is not silently replaced by a default.
    expect(await resolveAgentExecutable(join(bin, "missing"), env)).toBeUndefined();
  });
});
