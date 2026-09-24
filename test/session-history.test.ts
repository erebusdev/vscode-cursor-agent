import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/shared/protocol";
import {
  bulkTargets,
  filterSessions,
  groupSessions,
  historyGroup,
  lastSession,
  matchesQuery,
  pruneSelection,
  recentSessions,
  selectionState,
  sessionLabel,
  sortSessions,
  toggleAll,
  toggleSelected,
} from "../src/shared/sessionHistory";

// Wednesday 17 Sep 2025, 15:00 local time.
const NOW = new Date(2025, 8, 17, 15, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

const S = (sessionId: string, title: string | undefined, updatedAt: string | undefined, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId,
  ...(title !== undefined ? { title } : {}),
  ...(updatedAt !== undefined ? { updatedAt } : {}),
  ...extra,
});

describe("session history", () => {
  it("groups by calendar day, week and month", () => {
    expect(historyGroup(at(2025, 8, 17, 0), NOW)).toBe("Today");
    expect(historyGroup(at(2025, 8, 16, 23), NOW)).toBe("Yesterday");
    expect(historyGroup(at(2025, 8, 11), NOW)).toBe("This week");
    expect(historyGroup(at(2025, 8, 10), NOW)).toBe("This month");
    expect(historyGroup(at(2025, 8, 1, 0), NOW)).toBe("This month");
    expect(historyGroup(at(2025, 7, 31, 23), NOW)).toBe("Older");
    expect(historyGroup(undefined, NOW)).toBe("Older");
    expect(historyGroup("not a date", NOW)).toBe("Older");
  });

  it("labels untitled sessions by the start of their id", () => {
    expect(sessionLabel(S("abcdef123456", "  ", undefined))).toBe("abcdef12");
    expect(sessionLabel(S("abcdef123456", " Fix bug ", undefined))).toBe("Fix bug");
  });

  it("searches title, id and folder; every word must match", () => {
    const s = S("abc123", "Fix greeting bug", undefined, { cwd: "/work/site" });
    expect(matchesQuery(s, "")).toBe(true);
    expect(matchesQuery(s, "GREETING")).toBe(true);
    expect(matchesQuery(s, "abc1")).toBe(true);
    expect(matchesQuery(s, "site fix")).toBe(true);
    expect(matchesQuery(s, "fix readme")).toBe(false);
  });

  it("filters hidden sessions unless asked", () => {
    const list = [S("a", "One", undefined), S("b", "Two", undefined, { hidden: true })];
    expect(filterSessions(list, {}).map((s) => s.sessionId)).toEqual(["a"]);
    expect(filterSessions(list, { showHidden: true }).map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(filterSessions(list, { showHidden: true, query: "two" }).map((s) => s.sessionId)).toEqual(["b"]);
  });

  it("sorts newest, oldest and by title with undated sessions last", () => {
    const list = [S("x", "beta", at(2025, 8, 10)), S("y", "Alpha 10", undefined), S("z", "alpha 9", at(2025, 8, 17)), S("w", undefined, at(2025, 8, 12))];
    expect(sortSessions(list, "newest").map((s) => s.sessionId)).toEqual(["z", "w", "x", "y"]);
    expect(sortSessions(list, "oldest").map((s) => s.sessionId)).toEqual(["x", "w", "z", "y"]);
    // Numeric-aware, case-insensitive; the untitled "w" sorts by its id.
    expect(sortSessions(list, "title").map((s) => s.sessionId)).toEqual(["z", "y", "x", "w"]);
    expect(list.map((s) => s.sessionId)).toEqual(["x", "y", "z", "w"]);
  });

  it("groups a sorted list in order of appearance", () => {
    const list = [S("t", "t", at(2025, 8, 17)), S("o", "o", at(2025, 5, 1)), S("y", "y", at(2025, 8, 16)), S("t2", "t2", at(2025, 8, 17, 9))];
    const newest = groupSessions(sortSessions(list, "newest"), "newest", NOW);
    expect(newest.map((g) => [g.name, g.items.map((s) => s.sessionId)])).toEqual([
      ["Today", ["t", "t2"]],
      ["Yesterday", ["y"]],
      ["Older", ["o"]],
    ]);
    expect(groupSessions(sortSessions(list, "oldest"), "oldest", NOW).map((g) => g.name)).toEqual(["Older", "Yesterday", "Today"]);
    expect(groupSessions(sortSessions(list, "title"), "title", NOW)).toEqual([{ name: "All sessions", items: sortSessions(list, "title") }]);
    expect(groupSessions([], "newest", NOW)).toEqual([]);
  });

  it("picks recent and last sessions from visible ones", () => {
    const list = [S("old", "Old", at(2025, 8, 1)), S("cur", "Current", at(2025, 8, 17)), S("hid", "Hidden", at(2025, 8, 17, 14), { hidden: true }), S("mid", "Mid", at(2025, 8, 12))];
    expect(recentSessions(list, 2).map((s) => s.sessionId)).toEqual(["cur", "mid"]);
    expect(lastSession(list, "cur")?.sessionId).toBe("mid");
    expect(lastSession(list, undefined)?.sessionId).toBe("cur");
    expect(lastSession([S("cur", "Current", undefined)], "cur")).toBeUndefined();
  });

  it("tracks a multi-selection over the shown rows", () => {
    let sel = toggleSelected(new Set(), "a");
    expect([...sel]).toEqual(["a"]);
    expect(selectionState(sel, ["a", "b"])).toBe("some");
    sel = toggleAll(sel, ["a", "b"]);
    expect(selectionState(sel, ["a", "b"])).toBe("all");
    expect(toggleAll(sel, ["a", "b"]).size).toBe(0);
    expect(selectionState(new Set(), [])).toBe("none");
    expect([...toggleSelected(sel, "a")]).toEqual(["b"]);
    expect([...pruneSelection(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["a"]);
  });

  it("only targets sessions a bulk action would change", () => {
    const list = [S("a", "A", undefined), S("b", "B", undefined, { hidden: true }), S("c", "C", undefined)];
    const sel = new Set(["a", "b"]);
    expect(bulkTargets(sel, list, true)).toEqual(["a"]);
    expect(bulkTargets(sel, list, false)).toEqual(["b"]);
  });
});
