/**
 * The session history pane: shown inside the chat view in place of the
 * transcript (like the usage pane), from the header's history button, the
 * new-chat screen's History link or the Session History command. Search,
 * sort, date groups, inline rename, archive/unarchive (one or many) and resume.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { SessionSummary } from "../../shared/protocol";
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
} from "../../shared/sessionHistory";
import { pluralize, relativeTime } from "../format";
import { getState, resumeSession, setHistoryOpen, useSelector } from "../store";
import { getPersisted, persist, post } from "../vscode";
import { Popover } from "./Popover";
import { Icon, IconButton, Spinner, useNow } from "./ui";

/** Double-click renames, so a single click waits this long before resuming. */
const CLICK_DELAY_MS = 220;

function parseSort(value: unknown): HistorySort {
  return HISTORY_SORTS.some((s) => s.value === value) ? (value as HistorySort) : "newest";
}

function fullDate(updatedAt: string | undefined): string | undefined {
  const t = parseTime(updatedAt);
  return t === undefined ? undefined : new Date(t).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

/** Shows the session in the chat: closes the pane, then switches unless it is already the current one. */
function resume(sessionId: string): void {
  setHistoryOpen(false);
  resumeSession(sessionId);
}

function setHidden(ids: ReadonlyArray<string>, hidden: boolean): void {
  if (ids.length > 0) post({ type: "sessions.setHidden", sessionIds: ids, hidden });
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
          // Cancels the rename only; the pane stays open.
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
  const tooltip = selecting
    ? `${selected ? "Deselect" : "Select"} “${label}”`
    : [current ? `${label} (current session)` : `Resume “${label}”`, when && `Updated ${when}`, "Double-click to rename"].filter(Boolean).join("\n");
  const meta = [s.updatedAt ? relativeTime(s.updatedAt, now) : undefined, modelName].filter(Boolean).join(" · ");

  const onClick = (e: MouseEvent) => {
    window.clearTimeout(clickTimer.current);
    if (selecting) {
      onSelect();
      return;
    }
    // Keyboard activation (detail 0) resumes at once; a mouse click waits in case it becomes a double-click.
    if (e.detail === 0) resume(s.sessionId);
    else if (e.detail === 1) clickTimer.current = window.setTimeout(() => resume(s.sessionId), CLICK_DELAY_MS);
  };
  const onDblClick = () => {
    window.clearTimeout(clickTimer.current);
    if (!selecting) onRename(true);
  };

  return (
    <li class={`hrow${current ? " current" : ""}${s.hidden ? " is-hidden" : ""}${selected ? " selected" : ""}${selecting ? " selecting" : ""}${renaming ? " renaming" : ""}`}>
      <span class="hrow-lead">
        {selecting ? (
          <SelectBox state={selected ? "all" : "none"} label={`Select “${label}”`} onToggle={onSelect} class="hrow-check" />
        ) : (
          <Icon name={current ? "comment-discussion" : "comment"} class="hrow-icon" />
        )}
      </span>
      <div class="hrow-body">
        {renaming ? (
          <RenameInput session={s} onDone={() => onRename(false)} />
        ) : (
          <button type="button" class="hrow-main" title={tooltip} aria-pressed={selecting ? selected : undefined} onClick={onClick} onDblClick={onDblClick}>
            <span class="hrow-title-line">
              <span class="hrow-title">{label}</span>
              {current && <span class="hrow-chip current">Current</span>}
              {s.hidden && <span class="hrow-chip">Archived</span>}
            </span>
            {meta && <span class="hrow-meta">{meta}</span>}
          </button>
        )}
      </div>
      {!renaming && !selecting && (
        <span class="hrow-actions">
          <IconButton icon={current ? "comment-discussion" : "play"} label={current ? "Show in chat" : "Resume in chat"} onClick={() => resume(s.sessionId)} />
          <IconButton icon="edit" label="Rename" onClick={() => onRename(true)} />
          <IconButton icon="copy" label="Copy session id" onClick={() => post({ type: "copy", text: s.sessionId })} />
          {s.hidden ? (
            <IconButton icon="inbox" label="Unarchive" onClick={() => setHidden([s.sessionId], false)} />
          ) : (
            <IconButton icon="archive" label="Archive" onClick={() => setHidden([s.sessionId], true)} />
          )}
        </span>
      )}
    </li>
  );
}

/** Sort and "Show archived" behind one toolbar button, so the toolbar fits a narrow sidebar. */
function ViewMenu({ sort, showHidden, onSort, onShowHidden }: { sort: HistorySort; showHidden: boolean; onSort: (s: HistorySort) => void; onShowHidden: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const changed = sort !== "newest" || showHidden;
  const sortLabel = HISTORY_SORTS.find((s) => s.value === sort)?.label ?? "Newest";
  return (
    <>
      <IconButton
        ref={anchor}
        icon="filter"
        label={`Sort and filter (${sortLabel}${showHidden ? ", archived shown" : ""})`}
        class={`history-tool${open ? " active" : ""}${changed ? " changed" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Sort and filter" role="menu" align="end" minWidth={180} class="history-view-menu">
        <div class="popover-heading">Sort by</div>
        <div class="popover-list">
          {HISTORY_SORTS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={sort === o.value}
              class={`popover-item${sort === o.value ? " selected" : ""}`}
              onClick={() => {
                onSort(o.value);
                setOpen(false);
              }}
            >
              <span class="popover-item-check">{sort === o.value && <Icon name="check" />}</span>
              <span class="popover-item-label">{o.label}</span>
            </button>
          ))}
        </div>
        <div class="popover-sep" role="separator" />
        <div class="popover-list">
          <button type="button" role="menuitemcheckbox" aria-checked={showHidden} class="popover-item" title="Include archived sessions" onClick={() => onShowHidden(!showHidden)}>
            <span class="popover-item-check">{showHidden && <Icon name="check" />}</span>
            <span class="popover-item-label">Show archived</span>
          </button>
        </div>
      </Popover>
    </>
  );
}

function HistoryState({ icon, title, detail, error, action }: { icon: string; title: string; detail?: ComponentChildren; error?: boolean; action?: ComponentChildren }) {
  return (
    <div class={`history-state${error ? " error" : ""}`} role={error ? "alert" : undefined}>
      <Icon name={icon} class="history-state-icon" />
      <div class="history-state-title">{title}</div>
      {detail && <div class="history-state-detail">{detail}</div>}
      {action}
    </div>
  );
}

export function HistoryView() {
  const sessions = useSelector((s) => s.sessions);
  const currentId = useSelector((s) => s.session.sessionId);
  const models = useSelector((s) => s.session.models?.availableModels);
  const seed = useSelector((s) => s.historyQuery);
  const now = useNow(true, 30_000);
  const [query, setQuery] = useState(() => getState().historyQuery);
  const [sort, setSortState] = useState<HistorySort>(() => parseSort(getPersisted().historySort));
  const [showHidden, setShowHiddenState] = useState(() => getPersisted().historyShowHidden === true);
  const [selecting, setSelecting] = useState(false);
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
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  // Opening the pane re-lists the sessions and puts the cursor in the search.
  useEffect(() => {
    post({ type: "session.list" });
    searchRef.current?.focus({ preventScroll: true });
  }, []);
  // Reopened with a search typed elsewhere (the header card) while already open.
  useEffect(() => setQuery(seed), [seed]);

  const shown = useMemo(() => sortSessions(filterSessions(sessions.list, { query, showHidden }), sort), [sessions.list, query, showHidden, sort]);
  const shownIds = useMemo(() => shown.map((s) => s.sessionId), [shown]);
  const sections = useMemo(() => groupSessions(shown, sort, now), [shown, sort, now]);
  const hiddenCount = sessions.list.filter((s) => s.hidden).length;
  const visibleCount = sessions.list.length - hiddenCount;
  const modelNames = useMemo(() => new Map((models ?? []).map((m) => [m.modelId, m.name])), [models]);

  // Selected rows that a search, archive or refresh removed are no longer selected.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneSelection(prev, shownIds);
      return next.size === prev.size ? prev : next;
    });
  }, [shownIds]);

  // "/" or Ctrl/Cmd+F jumps to the search box. Escape leaves select mode, then closes the pane (like the usage pane).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".popover")) return;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        if (selecting) stopSelecting();
        else setHistoryOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting]);

  const selState = selectionState(selected, shownIds);
  const toHide = bulkTargets(selected, sessions.list, true);
  const toUnhide = bulkTargets(selected, sessions.list, false);
  const bulk = (ids: string[], hidden: boolean) => {
    setHidden(ids, hidden);
    setSelected(new Set());
  };
  const refresh = () => post({ type: "session.list" });

  const firstLoad = sessions.loading && sessions.list.length === 0;
  const countLine = sessions.list.length === 0 ? "" : `${pluralize(visibleCount, "session")}${hiddenCount ? ` · ${hiddenCount} archived` : ""}`;
  const q = query.trim();

  return (
    <div class="pane history-view" role="region" aria-label="Session history">
      <div class="pane-top">
        <IconButton icon="arrow-left" label="Back to chat" onClick={() => setHistoryOpen(false)} />
        <h2 class="pane-title">History</h2>
        <span class="pane-subtitle" aria-live="polite">
          {countLine}
        </span>
        <span class="pane-top-actions">
          {sessions.loading ? <Spinner class="section-spinner" /> : <IconButton icon="refresh" label="Refresh the list" onClick={refresh} />}
        </span>
      </div>

      <div class="history-toolbar" role="search">
        <span class="history-search">
          <Icon name="search" class="history-search-icon" />
          <input
            ref={searchRef}
            type="text"
            class="text-input"
            placeholder="Search sessions"
            aria-label="Search sessions"
            title="Search by title, session id or folder (press / to focus). Enter resumes the first match."
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              } else if (e.key === "Enter" && shown[0] && q && !selecting) {
                e.preventDefault();
                resume(shown[0].sessionId);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                document.querySelector<HTMLElement>(".history-view .hrow-main")?.focus();
              }
            }}
          />
          {query && (
            <IconButton icon="close" class="history-search-clear" label="Clear the search (Escape)" onClick={() => {
              setQuery("");
              searchRef.current?.focus();
            }} />
          )}
        </span>
        <IconButton
          icon="checklist"
          label={selecting ? "Done selecting (Escape)" : "Select sessions to archive"}
          class={`history-tool${selecting ? " active" : ""}`}
          aria-pressed={selecting}
          disabled={!selecting && shown.length === 0}
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        />
        <ViewMenu sort={sort} showHidden={showHidden} onSort={setSort} onShowHidden={setShowHidden} />
      </div>

      <div
        class="pane-scroll history-scroll"
        onKeyDown={(e) => {
          // Up/Down move between rows.
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const target = e.target as HTMLElement;
          if (!target.classList.contains("hrow-main")) return;
          const rows = Array.from(document.querySelectorAll<HTMLElement>(".history-view .hrow-main"));
          const i = rows.indexOf(target);
          e.preventDefault();
          if (e.key === "ArrowUp" && i === 0) searchRef.current?.focus();
          else rows[e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : i - 1]?.focus();
        }}
      >
        {sessions.error && (
          <HistoryState
            icon="error"
            error
            title="Could not list sessions"
            detail={sessions.error}
            action={
              <button type="button" class="button secondary small" title="Ask the agent for the session list again" onClick={refresh}>
                <Icon name="refresh" /> Retry
              </button>
            }
          />
        )}

        {firstLoad && (
          <div class="settings-loading" role="status">
            <Spinner /> Loading sessions…
          </div>
        )}

        {!firstLoad && !sessions.error && sessions.list.length === 0 && <HistoryState icon="history" title="No sessions yet" detail="Sessions you start in this folder appear here." />}

        {!firstLoad && sessions.list.length > 0 && shown.length === 0 && (
          <HistoryState
            icon="search"
            title={q ? `No sessions match “${q}”` : "All sessions are archived"}
            action={
              q ? (
                <button type="button" class="link-button" title="Clear the search" onClick={() => setQuery("")}>
                  Clear search
                </button>
              ) : (
                <button type="button" class="link-button" title="Show archived sessions" onClick={() => setShowHidden(true)}>
                  Show archived
                </button>
              )
            }
          />
        )}

        {sections.map((section) => (
          <section key={section.name} class="history-group" aria-labelledby={`history-group-${section.name}`}>
            <h3 class="pane-heading history-group-head" id={`history-group-${section.name}`}>
              <span>{section.name}</span>
              <span class="history-group-count">{section.items.length}</span>
            </h3>
            <ul class="history-list" aria-labelledby={`history-group-${section.name}`}>
              {section.items.map((s) => (
                <HistoryRow
                  key={s.sessionId}
                  session={s}
                  current={s.sessionId === currentId}
                  selected={selected.has(s.sessionId)}
                  selecting={selecting}
                  renaming={renaming === s.sessionId}
                  modelName={s.modelId ? (modelNames.get(s.modelId) ?? s.modelId) : undefined}
                  now={now}
                  onSelect={() => setSelected((prev) => toggleSelected(prev, s.sessionId))}
                  onRename={(on) => setRenaming(on ? s.sessionId : undefined)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {selecting && (
        <div class="history-bulk" role="toolbar" aria-label="Selected sessions">
          <SelectBox state={selState} label={selState === "all" ? "Clear the selection" : "Select all shown sessions"} onToggle={() => setSelected(toggleAll(selected, shownIds))} />
          <span class="history-bulk-label" aria-live="polite">
            {selected.size > 0 ? `${selected.size} selected` : "Select sessions"}
          </span>
          <span class="history-bulk-actions">
            <button type="button" class="button secondary small" disabled={toHide.length === 0} title={toHide.length ? `Archive ${pluralize(toHide.length, "session")}` : "Select sessions to archive"} onClick={() => bulk(toHide, true)}>
              <Icon name="archive" /> Archive
            </button>
            {(showHidden || toUnhide.length > 0) && (
              <button type="button" class="button secondary small" disabled={toUnhide.length === 0} title={toUnhide.length ? `Unarchive ${pluralize(toUnhide.length, "session")}` : "Select archived sessions to unarchive"} onClick={() => bulk(toUnhide, false)}>
                <Icon name="inbox" /> Unarchive
              </button>
            )}
            <button type="button" class="button tertiary small" title="Leave select mode (Escape)" onClick={stopSelecting}>
              Done
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
