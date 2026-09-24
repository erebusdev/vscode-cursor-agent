/**
 * Pure helpers for the session history (header overlay, history pane and the
 * new-chat screen): date groups, search, sort and multi-select.
 */
import type { SessionSummary } from "./protocol";

export type HistoryGroup = "Today" | "Yesterday" | "This week" | "This month" | "Older";
export type HistorySort = "newest" | "oldest" | "title";

export const HISTORY_SORTS: ReadonlyArray<{ readonly value: HistorySort; readonly label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "title", label: "Title" },
];

const DAY_MS = 86_400_000;

export function parseTime(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : undefined;
}

/** The title shown for a session: the (renamed) title, else the start of its id. */
export function sessionLabel(s: SessionSummary): string {
  return s.title?.trim() || s.sessionId.slice(0, 8);
}

/**
 * Buckets a session by calendar day relative to `now` (local time). "This week"
 * is the five days before yesterday; "This month" the rest of the calendar month.
 * Unknown dates fall into "Older".
 */
export function historyGroup(updatedAt: string | undefined, now: number): HistoryGroup {
  const t = parseTime(updatedAt);
  if (t === undefined) return "Older";
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (t >= today) return "Today";
  if (t >= today - DAY_MS) return "Yesterday";
  if (t >= today - 6 * DAY_MS) return "This week";
  start.setDate(1);
  if (t >= start.getTime()) return "This month";
  return "Older";
}

/** Case-insensitive match on the title, the session id and the folder; every word must match. */
export function matchesQuery(s: SessionSummary, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [s.title ?? "", s.sessionId, s.cwd ?? ""].join("\n").toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/** Sessions matching the search, hidden ones only when asked for. */
export function filterSessions(list: ReadonlyArray<SessionSummary>, options: { readonly query?: string; readonly showHidden?: boolean }): SessionSummary[] {
  return list.filter((s) => (options.showHidden || !s.hidden) && matchesQuery(s, options.query ?? ""));
}

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sorted copy. Undated sessions go last for both date orders; ties keep their input order. */
export function sortSessions(list: ReadonlyArray<SessionSummary>, sort: HistorySort): SessionSummary[] {
  const indexed = list.map((s, i) => ({ s, i, t: parseTime(s.updatedAt) }));
  indexed.sort((a, b) => {
    if (sort === "title") return titleCollator.compare(sessionLabel(a.s), sessionLabel(b.s)) || a.i - b.i;
    if (a.t === undefined || b.t === undefined) return (a.t === undefined ? 1 : 0) - (b.t === undefined ? 1 : 0) || a.i - b.i;
    return (sort === "newest" ? b.t - a.t : a.t - b.t) || a.i - b.i;
  });
  return indexed.map((x) => x.s);
}

export interface HistorySection {
  readonly name: string;
  readonly items: SessionSummary[];
}

/**
 * Splits an already sorted list into sections. Date sorts get date groups in
 * the order they first appear (so "Oldest" starts with "Older"); the title
 * sort is one alphabetical section.
 */
export function groupSessions(sorted: ReadonlyArray<SessionSummary>, sort: HistorySort, now: number): HistorySection[] {
  if (sorted.length === 0) return [];
  if (sort === "title") return [{ name: "All sessions", items: [...sorted] }];
  const sections: HistorySection[] = [];
  const byName = new Map<string, HistorySection>();
  for (const s of sorted) {
    const name = historyGroup(s.updatedAt, now);
    let section = byName.get(name);
    if (!section) {
      section = { name, items: [] };
      byName.set(name, section);
      sections.push(section);
    }
    section.items.push(s);
  }
  return sections;
}

/** The newest visible sessions, for the header overlay. */
export function recentSessions(list: ReadonlyArray<SessionSummary>, limit: number): SessionSummary[] {
  return sortSessions(
    list.filter((s) => !s.hidden),
    "newest",
  ).slice(0, limit);
}

/** The newest visible session other than the current one (the new-chat screen's "Resume" link). */
export function lastSession(list: ReadonlyArray<SessionSummary>, currentId: string | undefined): SessionSummary | undefined {
  return recentSessions(
    list.filter((s) => s.sessionId !== currentId),
    1,
  )[0];
}

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

export type SelectionState = "none" | "some" | "all";

export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Whether all, some or none of the shown sessions are selected. */
export function selectionState(selected: ReadonlySet<string>, shownIds: ReadonlyArray<string>): SelectionState {
  if (shownIds.length === 0) return "none";
  const n = shownIds.reduce((count, id) => count + (selected.has(id) ? 1 : 0), 0);
  return n === 0 ? "none" : n === shownIds.length ? "all" : "some";
}

/** The header checkbox: selects every shown session, or clears the selection when all are selected. */
export function toggleAll(selected: ReadonlySet<string>, shownIds: ReadonlyArray<string>): Set<string> {
  return selectionState(selected, shownIds) === "all" ? new Set() : new Set(shownIds);
}

/** Drops selected ids that are no longer shown (after a search, a hide or a refresh). */
export function pruneSelection(selected: ReadonlySet<string>, shownIds: ReadonlyArray<string>): Set<string> {
  const shown = new Set(shownIds);
  return new Set([...selected].filter((id) => shown.has(id)));
}

/** The selected sessions a bulk Hide (`hidden: true`) or Unhide would change. */
export function bulkTargets(selected: ReadonlySet<string>, list: ReadonlyArray<SessionSummary>, hidden: boolean): string[] {
  return list.filter((s) => selected.has(s.sessionId) && !!s.hidden !== hidden).map((s) => s.sessionId);
}
