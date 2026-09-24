/**
 * The session history editor tab: search, sort, date groups, inline rename,
 * hide/unhide (one or many) and resume. Loaded from the same bundle as the
 * chat, in the webview the host marks with `data-view="history"`.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SessionSummary } from "../../../shared/protocol";
import {
  bulkTargets,
  filterSessions,
  groupSessions,
  HISTORY_SORTS,
  type HistorySort,
  parseTime,
  pruneSelection,
  selectionState,
  sessionLabel,
  sortSessions,
  toggleAll,
  toggleSelected,
} from "../../../shared/sessionHistory";
import { pluralize, relativeTime } from "../../format";
import { useSelector } from "../../store";
import { getPersisted, persist, post } from "../../vscode";
import { Toggle, Select } from "../settings/controls";
import { Toasts } from "../Toasts";
import { Icon, IconButton, Spinner, useNow } from "../ui";

/** Double-click renames, so a single click waits this long before resuming. */
const CLICK_DELAY_MS = 220;

function parseSort(value: unknown): HistorySort {
  return HISTORY_SORTS.some((s) => s.value === value) ? (value as HistorySort) : "newest";
}

function fullDate(updatedAt: string | undefined): string | undefined {
  const t = parseTime(updatedAt);
  return t === undefined ? undefined : new Date(t).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

function resume(sessionId: string): void {
  post({ type: "history.resume", sessionId });
}

/** Square checkbox with a mixed state (the "select all" box). */
function SelectBox({ state, label, onToggle, class: cls }: { state: "none" | "some" | "all"; label: string; onToggle: () => void; class?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      title={label}
      class={`checkbox${state === "all" ? " checked" : state === "some" ? " mixed" : ""}${cls ? ` ${cls}` : ""}`}
      onClick={onToggle}
    >
      {state === "all" && <Icon name="check" />}
      {state === "some" && <Icon name="dash" />}
    </button>
  );
}

function RenameInput({ session, onDone }: { session: SessionSummary; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const title = ref.current?.value.trim() ?? "";
    if (title !== (session.title?.trim() ?? "")) post({ type: "session.rename", sessionId: session.sessionId, title });
    onDone();
  };
  return (
    <input
      ref={ref}
      type="text"
      class="text-input hrow-rename"
      defaultValue={session.title?.trim() ?? ""}
      placeholder="Leave empty to use Cursor's title"
      aria-label="Session title"
      title="Enter to save, Escape to cancel. Leave empty to use Cursor's title."
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onDone();
        }
      }}
      onBlur={commit}
    />
  );
}

interface RowProps {
  session: SessionSummary;
  current: boolean;
  selected: boolean;
  selecting: boolean;
  renaming: boolean;
  modelName: string | undefined;
  now: number;
  onSelect: () => void;
  onRename: (on: boolean) => void;
}

function HistoryRow({ session: s, current, selected, selecting, renaming, modelName, now, onSelect, onRename }: RowProps) {
  const clickTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  const label = sessionLabel(s);
  const when = fullDate(s.updatedAt);
  const tooltip = [current ? `${label} (current session)` : `Resume “${label}”`, when && `Updated ${when}`, "Double-click to rename"].filter(Boolean).join("\n");
  const meta = [modelName, s.sessionId.slice(0, 8)].filter(Boolean).join(" · ");

  const onClick = (e: MouseEvent) => {
    window.clearTimeout(clickTimer.current);
    // Keyboard activation (detail 0) resumes at once; a mouse click waits in case it becomes a double-click.
    if (e.detail === 0) resume(s.sessionId);
    else if (e.detail === 1) clickTimer.current = window.setTimeout(() => resume(s.sessionId), CLICK_DELAY_MS);
  };
  const onDblClick = () => {
    window.clearTimeout(clickTimer.current);
    onRename(true);
  };

  return (
    <li class={`hrow${current ? " current" : ""}${s.hidden ? " is-hidden" : ""}${selected ? " selected" : ""}${selecting ? " selecting" : ""}`}>
      {/* The session icon turns into a checkbox on hover, focus or while selecting. */}
      <span class="hrow-lead">
        <Icon name={current ? "comment-discussion" : "comment"} class="hrow-icon" />
        <SelectBox state={selected ? "all" : "none"} label={`Select “${label}”`} onToggle={onSelect} class="hrow-check" />
      </span>
      <div class="hrow-body">
        {renaming ? (
          <RenameInput session={s} onDone={() => onRename(false)} />
        ) : (
          <button type="button" class="hrow-main" title={tooltip} onClick={onClick} onDblClick={onDblClick}>
            <span class="hrow-title-line">
              <span class="hrow-title">{label}</span>
              {current && <span class="hrow-chip current">Current</span>}
              {s.hidden && <span class="hrow-chip">Hidden</span>}
            </span>
            {meta && <span class="hrow-meta">{meta}</span>}
          </button>
        )}
      </div>
      <span class="hrow-end">
      {s.updatedAt && (
        <span class="hrow-time" title={when}>
          {relativeTime(s.updatedAt, now)}
        </span>
      )}
      <span class="hrow-actions">
        <IconButton icon={current ? "comment-discussion" : "play"} label={current ? "Show in chat" : "Resume in chat"} onClick={() => resume(s.sessionId)} />
        <IconButton icon="edit" label="Rename" onClick={() => onRename(true)} />
        <IconButton icon="copy" label="Copy session id" onClick={() => post({ type: "copy", text: s.sessionId })} />
        {s.hidden ? (
          <IconButton icon="eye" label="Unhide (show in history again)" onClick={() => post({ type: "sessions.setHidden", sessionIds: [s.sessionId], hidden: false })} />
        ) : (
          <IconButton icon="eye-closed" label="Hide from history" onClick={() => post({ type: "sessions.setHidden", sessionIds: [s.sessionId], hidden: true })} />
        )}
      </span>
      </span>
    </li>
  );
}

export function HistoryApp() {
  const sessions = useSelector((s) => s.sessions);
  const currentId = useSelector((s) => s.session.sessionId);
  const models = useSelector((s) => s.session.models?.availableModels);
  const now = useNow(true, 30_000);
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<HistorySort>(() => parseSort(getPersisted().historySort));
  const [showHidden, setShowHiddenState] = useState(() => getPersisted().historyShowHidden === true);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);

  const setSort = (next: HistorySort) => {
    setSortState(next);
    persist({ historySort: next });
  };
  const setShowHidden = (next: boolean) => {
    setShowHiddenState(next);
    persist({ historyShowHidden: next });
  };

  const shown = useMemo(() => sortSessions(filterSessions(sessions.list, { query, showHidden }), sort), [sessions.list, query, showHidden, sort]);
  const shownIds = useMemo(() => shown.map((s) => s.sessionId), [shown]);
  const sections = useMemo(() => groupSessions(shown, sort, now), [shown, sort, now]);
  const hiddenCount = sessions.list.filter((s) => s.hidden).length;
  const visibleCount = sessions.list.length - hiddenCount;
  const modelNames = useMemo(() => new Map((models ?? []).map((m) => [m.modelId, m.name])), [models]);

  // Selected rows that a search, hide or refresh removed are no longer selected.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneSelection(prev, shownIds);
      return next.size === prev.size ? prev : next;
    });
  }, [shownIds]);

  // "/" or Ctrl/Cmd+F jumps to the search box; Escape there clears it, then the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && !typing && !e.defaultPrevented) {
        setSelected(new Set());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const selState = selectionState(selected, shownIds);
  const toHide = bulkTargets(selected, sessions.list, true);
  const toUnhide = bulkTargets(selected, sessions.list, false);
  const setHidden = (ids: string[], hidden: boolean) => {
    if (ids.length === 0) return;
    post({ type: "sessions.setHidden", sessionIds: ids, hidden });
    setSelected(new Set());
  };
  const refresh = () => post({ type: "session.list" });

  const firstLoad = sessions.loading && sessions.list.length === 0;
  const countLine = sessions.list.length === 0 ? "" : `${pluralize(visibleCount, "session")}${hiddenCount ? ` · ${hiddenCount} hidden` : ""}`;

  return (
    <div class="settings-app history-app">
      <main class="settings-main history-main" aria-labelledby="history-title">
        <div class="settings-content history-content">
          <div class="history-head">
            <h1 id="history-title" class="settings-page-title">
              History
            </h1>
            <span class="history-count" aria-live="polite">
              {countLine}
            </span>
            <span class="history-head-actions">
              {sessions.loading ? <Spinner class="section-spinner" /> : <IconButton icon="refresh" label="Refresh the list" onClick={refresh} />}
              <button type="button" class="button secondary small" title="Start a new session in the chat" onClick={() => post({ type: "session.new" })}>
                <Icon name="add" /> New session
              </button>
            </span>
          </div>

          <div class="history-toolbar" role="search">
            <span class="history-search">
              <Icon name="search" class="history-search-icon" />
              <input
                ref={searchRef}
                type="search"
                class="text-input"
                placeholder="Search by title or session id"
                aria-label="Search sessions"
                title="Search sessions by title, session id or folder (press / to focus)"
                value={query}
                onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.preventDefault();
                    setQuery("");
                  } else if (e.key === "Enter" && shown[0] && query.trim()) {
                    e.preventDefault();
                    resume(shown[0].sessionId);
                  }
                }}
              />
            </span>
            <span class="history-option">
              <label for="history-show-hidden" class="history-option-label">
                Show hidden
              </label>
              <Toggle id="history-show-hidden" checked={showHidden} onChange={setShowHidden} title={showHidden ? "Hidden sessions are listed" : "List sessions you hid"} />
            </span>
            <span class="history-option">
              <label for="history-sort" class="history-option-label">
                Sort
              </label>
              <Select id="history-sort" value={sort} options={HISTORY_SORTS} onChange={setSort} />
            </span>
          </div>

          {shown.length > 0 && (
            <div class={`history-bulk${selected.size > 0 ? " active" : ""}`}>
              <SelectBox state={selState} label={selState === "all" ? "Clear the selection" : "Select all shown sessions"} onToggle={() => setSelected(toggleAll(selected, shownIds))} />
              <span class="history-bulk-label">{selected.size > 0 ? `${selected.size} selected` : "Select"}</span>
              {selected.size > 0 && (
                <span class="history-bulk-actions">
                  <button type="button" class="button secondary small" disabled={toHide.length === 0} title={`Hide ${pluralize(toHide.length, "session")} from history`} onClick={() => setHidden(toHide, true)}>
                    <Icon name="eye-closed" /> Hide
                  </button>
                  {(showHidden || toUnhide.length > 0) && (
                    <button type="button" class="button secondary small" disabled={toUnhide.length === 0} title={`Show ${pluralize(toUnhide.length, "session")} in history again`} onClick={() => setHidden(toUnhide, false)}>
                      <Icon name="eye" /> Unhide
                    </button>
                  )}
                  <button type="button" class="link-button" title="Clear the selection (Escape)" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                </span>
              )}
            </div>
          )}

          {sessions.error && (
            <div class="history-state error" role="alert">
              <Icon name="error" />
              <div class="history-state-text">
                <div class="history-state-title">Could not list sessions</div>
                <div class="history-state-detail">{sessions.error}</div>
              </div>
              <button type="button" class="button secondary small" title="Ask the agent for the session list again" onClick={refresh}>
                <Icon name="refresh" /> Retry
              </button>
            </div>
          )}

          {firstLoad && (
            <div class="history-state" role="status">
              <Spinner /> Loading sessions…
            </div>
          )}

          {!firstLoad && !sessions.error && sessions.list.length === 0 && (
            <div class="history-state empty">
              <Icon name="history" class="history-state-icon" />
              <div class="history-state-text">
                <div class="history-state-title">No sessions yet</div>
                <div class="history-state-detail">Sessions you start in this folder appear here.</div>
              </div>
            </div>
          )}

          {!firstLoad && sessions.list.length > 0 && shown.length === 0 && (
            <div class="history-state empty">
              <Icon name="search" class="history-state-icon" />
              <div class="history-state-text">
                <div class="history-state-title">{query.trim() ? `No sessions match “${query.trim()}”` : "All sessions are hidden"}</div>
                <div class="history-state-detail">
                  {query.trim() ? (
                    <button type="button" class="link-button" title="Clear the search" onClick={() => setQuery("")}>
                      Clear search
                    </button>
                  ) : (
                    <button type="button" class="link-button" title="List hidden sessions" onClick={() => setShowHidden(true)}>
                      Show hidden sessions
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {sections.map((section) => (
            <section key={section.name} class="sgroup history-group" aria-labelledby={`history-group-${section.name}`}>
              <div class="sgroup-head">
                <h2 class="sgroup-title" id={`history-group-${section.name}`}>
                  {section.name}
                </h2>
                <span class="sgroup-note">{section.items.length}</span>
              </div>
              <ul class="scard history-card" aria-labelledby={`history-group-${section.name}`}>
                {section.items.map((s) => (
                  <HistoryRow
                    key={s.sessionId}
                    session={s}
                    current={s.sessionId === currentId}
                    selected={selected.has(s.sessionId)}
                    selecting={selected.size > 0}
                    renaming={renaming === s.sessionId}
                    modelName={s.modelId ? (modelNames.get(s.modelId) ?? s.modelId) : undefined}
                    now={now}
                    onSelect={() => setSelected(toggleSelected(selected, s.sessionId))}
                    onRename={(on) => setRenaming(on ? s.sessionId : undefined)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
      <Toasts />
    </div>
  );
}
