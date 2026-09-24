import { describe, expect, it } from "vitest";
import { DEFAULT_SAFE_LIST, commandName, compileSafeList, isSafe, sessionKey, splitShellSegments, subjectFrom } from "../src/extension/session/approvals";

const list = compileSafeList(DEFAULT_SAFE_LIST);
const safe = (command: string) => isSafe({ command, title: command }, list);

describe("safe list", () => {
  it("compiles the defaults without errors", () => {
    expect(list.invalid).toEqual([]);
    expect(list.patterns.length).toBe(DEFAULT_SAFE_LIST.length);
  });

  it("allows read-only commands and pipelines of them", () => {
    for (const c of ["ls -la", "cat package.json | head -20", "git status && git diff --stat", "rg TODO src | wc -l", "cd src; ls", "node --version", "gh pr view 12 --json title", "acli jira workitem search --jql 'project = FLEX'", "grep -r foo . 2>/dev/null", "cat x >/dev/null"]) {
      expect(safe(c), c).toBe(true);
    }
  });

  it("asks for anything that writes, runs, or hides a command", () => {
    for (const c of ["rm -rf build", "cat x > y", "ls $(rm -rf /)", "echo `whoami`", "git push", "npm install", "bash -c 'ls'", "eval ls", "ls | sh", "cat 'unterminated", "sed -i s/a/b/ file", "gh api repos/x/y", "git status; rm -rf ."]) {
      expect(safe(c), c).toBe(false);
    }
  });

  it("matches Cursor's MCP permission patterns by tool name", () => {
    const read = subjectFrom({ title: "searchJiraIssuesUsingJql", reason: "Not in allowlist: Mcp(plugin-atlassian-atlassian:searchJiraIssuesUsingJql)" });
    const write = subjectFrom({ title: "createJiraIssue", reason: "Not in allowlist: Mcp(plugin-atlassian-atlassian:createJiraIssue)" });
    expect(read.pattern).toBe("Mcp(plugin-atlassian-atlassian:searchJiraIssuesUsingJql)");
    expect(isSafe(read, list)).toBe(true);
    expect(isSafe(write, list)).toBe(false);
  });

  it("honours user patterns and skips invalid ones", () => {
    const custom = compileSafeList(["^make test$", "(unclosed"]);
    expect(custom.invalid).toEqual(["(unclosed"]);
    expect(isSafe({ command: "make test", title: "make test" }, custom)).toBe(true);
    expect(isSafe({ command: "make deploy", title: "make deploy" }, custom)).toBe(false);
  });
});

describe("session keys", () => {
  it("uses the command name for shell commands", () => {
    expect(commandName("FOO=1 sudo /usr/bin/npm test")).toBe("npm");
    expect(sessionKey({ command: "gh pr list", title: "gh pr list" })).toBe("gh");
  });

  it("uses Cursor's pattern for MCP tools", () => {
    expect(sessionKey(subjectFrom({ title: "getX", reason: "Not in allowlist: Mcp(a:getX)" }))).toBe("Mcp(a:getX)");
  });

  it("splits on operators but not inside quotes", () => {
    expect(splitShellSegments(`grep "a | b" f && echo 'x; y'`)).toEqual([`grep "a | b" f`, `echo 'x; y'`]);
  });
});

describe("package.json", () => {
  it("ships the same default safe list as the code", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.contributes.configuration.properties["cursorAcp.safeList"].default).toEqual(DEFAULT_SAFE_LIST);
  });
});
