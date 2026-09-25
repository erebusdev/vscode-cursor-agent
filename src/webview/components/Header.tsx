import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../../shared/protocol";
import { parseTime, recentMatches, sessionLabel } from "../../shared/sessionHistory";
import { pluralize, relativeTime } from "../format";
import { getState, openHistory, openSettings, resumeSession, setHistoryOpen, useSelector } from "../store";
import { post } from "../vscode";
import { Popover } from "./Popover";
import { UsageButton } from "./Usage";
import { ChangeCounts, Icon, IconButton, Spinner, useNow } from "./ui";

const STATUS_LABEL: Record<ConnectionState, string> = {
  idle: "Idle",
  starting: "Starting",
  loading: "Loading history",
  ready: "Ready",
  running: "Running",
  cancelling: "Cancelling",
  disconnected: "Disconnected",
  error: "Error",
};

function ChangesChip() {
  const changed = useSelector((s) => s.session.changedFiles);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (changed.length === 0) return null;
  const adds = changed.reduce((n, f) => n + f.additions, 0);
  const dels = changed.reduce((n, f) => n + f.deletions, 0);
  return (
    <>
      <button ref={anchor} type="button" class="chip changes-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} title={pluralize(changed.length, "changed file")}>
        <Icon name="git-commit" />
        <span class="chip-label">{pluralize(changed.length, "change")}</span>
        <ChangeCounts additions={adds} deletions={dels} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Changed files" align="end" minWidth={240} class="changes-popover">
        <div class="popover-heading">Changed files</div>
        <ul class="changes-list">
          {changed.map((f) => (
            <li key={f.path} class="changes-row">
              <button type="button" class="changes-file" title={f.path} onClick={() => post({ type: "openFile", path: f.path })}>
                <Icon name="file" />
                <span class="changes-name">{f.displayPath}</span>
              </button>
              <ChangeCounts additions={f.additions} deletions={f.deletions} />
              <IconButton icon="diff" label={`Open diff for ${f.displayPath}`} onClick={() => post({ type: "openDiff", itemId: "", path: f.path })} />
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}

export function Header() {
  const session = useSelector((s) => s.session);
  const c = session.connection;
  const busy = c === "starting" || c === "loading" || c === "running" || c === "cancelling";
  const title = session.title?.trim() || "New session";
  const canReconnect = c === "disconnected" || c === "error";

  return (
    <header class="header">
      <div class="header-main">
        {session.sessionId ? (
          <button type="button" class="header-title header-title-button" title={`Rename session\nSession id: ${session.sessionId}`} onClick={() => post({ type: "session.rename", sessionId: session.sessionId! })}>
            {title}
          </button>
        ) : (
          <span class="header-title" title={title}>
            {title}
          </span>
        )}
        {session.sessionId && (
          <>
            <IconButton icon="edit" class="header-copy-id" label="Rename session" onClick={() => post({ type: "session.rename", sessionId: session.sessionId! })} />
            <IconButton icon="copy" class="header-copy-id" label="Copy session id" onClick={() => post({ type: "copy", text: session.sessionId! })} />
          </>
        )}
        {session.approvalPolicy === "auto" && (
          <span class="auto-badge" title="Approvals: Auto. Every command and tool call runs without asking for this session.">
            <Icon name="unlock" /> Auto
          </span>
        )}
        <span class={`status status-${c}`} title={session.lastError ?? STATUS_LABEL[c]} role="status" aria-label={STATUS_LABEL[c]}>
          {busy ? <Spinner class="status-spinner" /> : <span class="status-dot" />}
          {c !== "ready" && c !== "running" && <span class="status-label">{STATUS_LABEL[c]}</span>}
        </span>
      </div>
      <div class="header-side">
        {session.workspaceName && (
          <span class="workspace" title={session.cwd}>
            {session.remoteName && (
              <span class="remote-badge" title={session.remoteName}>
                <Icon name="remote" />
                <span class="remote-badge-text">{session.remoteName}</span>
              </span>
            )}
            <Icon name="folder" />
            <span class="workspace-name">{session.workspaceName}</span>
          </span>
        )}
        <ChangesChip />
        <span class="header-actions">
          {canReconnect && <IconButton icon="refresh" label="Reconnect agent" onClick={() => post({ type: "session.reconnect" })} />}
          <IconButton icon="add" label="New session" onClick={() => post({ type: "session.new" })} />
          <UsageButton />
          <HistoryButton />
          <SettingsGear />
        </span>
      </div>
    </header>
  );
}

function SettingsGear() {
  return <IconButton icon="settings-gear" label="Settings (opens in an editor tab)" onClick={() => openSettings()} />;
}

const HISTORY_HOVER_OPEN_MS = 250;
const HISTORY_HOVER_CLOSE_MS = 250;
const HISTORY_RECENT = 8;
/** Opening the overlay re-lists sessions at most this often. */
const HISTORY_REFRESH_MS = 10_000;

/**
 * Header history button. Hovering shows the recent sessions in a card that
 * does not take focus until the pointer moves into it (or the user clicks its
 * filter, types on the button or presses ArrowDown); then its filter has focus.
 * Clicking the button (or Enter/Space) toggles the history pane in the chat
 * view, like the usage button.
 */
function HistoryButton() {
  const sessions = useSelector((s) => s.sessions);
  const currentId = useSelector((s) => s.session.sessionId);
  const paneOpen = useSelector((s) => s.pane === "history");
  // "hover": a preview that never takes focus; "active": the filter (or a row) has focus.
  const [open, setOpen] = useState<false | "hover" | "active">(false);
  const [filter, setFilter] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const listedAt = useRef(0);
  const now = useNow(open !== false, 30_000);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (open !== "hover") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  // A closed card forgets its filter.
  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  const refresh = () => {
    if (Date.now() - listedAt.current < HISTORY_REFRESH_MS) return;
    listedAt.current = Date.now();
    post({ type: "session.list" });
  };
  const hold = () => window.clearTimeout(timer.current);
  const show = () => {
    hold();
    if (open) return;
    timer.current = window.setTimeout(() => {
      // The pane already lists everything.
      if (getState().pane === "history") return;
      refresh();
      setOpen("hover");
    }, HISTORY_HOVER_OPEN_MS);
  };
  const hide = () => {
    hold();
    timer.current = window.setTimeout(() => {
      // A typed filter keeps the card open while focus is in it.
      if (input.current?.value.trim() && card.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, HISTORY_HOVER_CLOSE_MS);
  };
  /** Keeps the card open and moves focus to its filter (Popover focuses `data-autofocus` once active). */
  const activate = (seed?: string) => {
    hold();
    if (seed !== undefined) setFilter((f) => f + seed);
    if (open === "active") input.current?.focus();
    else {
      refresh();
      setOpen("active");
    }
  };
  const close = () => {
    hold();
    setOpen(false);
  };
  const togglePane = () => {
    close();
    setHistoryOpen(!paneOpen);
  };
  const openPane = () => {
    const query = filter.trim();
    close();
    openHistory(query);
  };
  const pick = (sessionId: string) => {
    close();
    resumeSession(sessionId);
  };

  const { items: recent, total } = recentMatches(sessions.list, filter, HISTORY_RECENT);
  const more = total - recent.length;
  const q = filter.trim();
  const active = open === "active";
  const anyVisible = sessions.list.some((s) => !s.hidden);

  return (
    <>
      <IconButton
        ref={anchor}
        icon="history"
        label="Session history"
        class={open || paneOpen ? "active" : undefined}
        aria-pressed={paneOpen}
        aria-haspopup="dialog"
        aria-expanded={active}
        data-hover-card=""
        onClick={togglePane}
        onMouseEnter={show}
        onMouseLeave={hide}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || (e.key === "ArrowUp" && open)) {
            e.preventDefault();
            activate();
          } else if (e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Typing on the button starts filtering the recent sessions.
            e.preventDefault();
            activate(e.key);
          }
        }}
      />
      <Popover anchor={anchor} open={open !== false} onClose={close} label="Recent sessions" align="end" class="history-hover-popover" manageFocus={active}>
        <div ref={card} class="history-hover" onMouseEnter={() => (open === "hover" ? activate() : hold())} onMouseLeave={hide}>
          <div class="popover-heading">
            Recent sessions {sessions.loading && <Spinner class="section-spinner" />}
          </div>
          <span class="history-hover-filter">
            <Icon name="search" class="history-search-icon" />
            <input
              ref={input}
              type="text"
              class="text-input"
              placeholder="Filter sessions"
              aria-label="Filter recent sessions"
              title="Filter by title or session id. Enter resumes the first match, ↓ moves to the list."
              data-autofocus=""
              value={filter}
              onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
              onMouseDown={() => activate()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && recent[0]) {
                  e.preventDefault();
                  pick(recent[0].sessionId);
                } else if (e.key === "Escape" && filter) {
                  // First Escape clears the filter; the next one closes the card.
                  e.preventDefault();
                  e.stopPropagation();
                  setFilter("");
                }
              }}
            />
          </span>
          {sessions.error && <div class="popover-empty error">{sessions.error}</div>}
          {!sessions.loading && !sessions.error && !anyVisible && <div class="popover-empty">No sessions yet in this folder.</div>}
          {anyVisible && recent.length === 0 && q && <div class="popover-empty">No sessions match “{q}”</div>}
          {recent.length > 0 && (
            <div class="popover-list history-hover-list">
              {recent.map((s) => {
                const current = s.sessionId === currentId;
                const label = sessionLabel(s);
                const t = parseTime(s.updatedAt);
                const when = t === undefined ? undefined : new Date(t).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
                const tooltip = [current ? `${label} (current session)` : `Resume “${label}”`, when].filter(Boolean).join("\n");
                return (
                  <button
                    key={s.sessionId}
                    type="button"
                    aria-current={current ? "true" : undefined}
                    class={`popover-item history-hover-item${current ? " selected" : ""}`}
                    title={tooltip}
                    onClick={() => pick(s.sessionId)}
                  >
                    <span class="popover-item-check">
                      <Icon name={current ? "check" : "comment"} />
                    </span>
                    <span class="popover-item-label">{label}</span>
                    <span class="history-hover-time">{current ? "Current" : relativeTime(s.updatedAt, now)}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div class="history-hover-footer">
            <span class="history-hover-more">{more > 0 ? `${more} more${q ? " matching" : ""}` : ""}</span>
            <button type="button" class="link-button" title={q ? `Open the history pane searching for “${q}”` : "Open the history pane"} onClick={openPane}>
              All history…
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}
