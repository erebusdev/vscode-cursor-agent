import { useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../../shared/protocol";
import { pluralize, relativeTime } from "../format";
import { openSettings, useSelector } from "../store";
import { post } from "../vscode";
import { Popover } from "./Popover";
import { UsageButton } from "./Usage";
import { ChangeCounts, Icon, IconButton, Spinner } from "./ui";

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

type HistoryGroup = "Today" | "Yesterday" | "This week" | "Older";
const HISTORY_GROUPS: ReadonlyArray<HistoryGroup> = ["Today", "Yesterday", "This week", "Older"];
const DAY_MS = 86_400_000;

function parseTime(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const t = Date.parse(input);
  return Number.isFinite(t) ? t : undefined;
}

/** Bucket a session by calendar day relative to `now`; unknown dates fall into "Older". */
function historyGroup(updatedAt: string | undefined, now: number): HistoryGroup {
  const t = parseTime(updatedAt);
  if (t === undefined) return "Older";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (t >= today) return "Today";
  if (t >= today - DAY_MS) return "Yesterday";
  if (t >= today - 6 * DAY_MS) return "This week";
  return "Older";
}

function fullDateTime(updatedAt: string | undefined): string | undefined {
  const t = parseTime(updatedAt);
  return t === undefined ? undefined : new Date(t).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

function HistoryButton() {
  const sessions = useSelector((s) => s.sessions);
  const currentId = useSelector((s) => s.session.sessionId);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    post({ type: "session.list" });
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setFilter("");
  };
  const load = (sessionId: string) => {
    close();
    if (sessionId !== currentId) post({ type: "session.load", sessionId });
  };

  const q = filter.trim().toLowerCase();
  const filtered = q ? sessions.list.filter((s) => (s.title?.trim() || s.sessionId).toLowerCase().includes(q)) : sessions.list;
  const now = Date.now();
  const groups = HISTORY_GROUPS.map((name) => ({ name, items: filtered.filter((s) => historyGroup(s.updatedAt, now) === name) })).filter((g) => g.items.length > 0);
  const ready = !sessions.loading && !sessions.error;

  return (
    <>
      <IconButton ref={anchor} icon="history" label="Session history" aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? close() : openMenu())} />
      <Popover anchor={anchor} open={open} onClose={close} label="Session history" role="listbox" align="end" minWidth={260} class="history-popover">
        <div class="popover-heading">
          Recent sessions {sessions.loading && <Spinner class="section-spinner" />}
        </div>
        <input
          type="text"
          class="text-input popover-filter"
          placeholder="Filter sessions…"
          aria-label="Filter sessions"
          title="Filter sessions by title. Enter opens the first match."
          data-autofocus
          value={filter}
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered.length > 0) {
              e.preventDefault();
              load(filtered[0]!.sessionId);
            }
          }}
        />
        {sessions.error && <div class="popover-empty error">{sessions.error}</div>}
        {ready && sessions.list.length === 0 && <div class="popover-empty">No sessions yet.</div>}
        {ready && sessions.list.length > 0 && filtered.length === 0 && <div class="popover-empty">No matching sessions</div>}
        <div class="popover-list">
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name} class="popover-group">
              <div class="popover-heading popover-subheading" aria-hidden="true">
                {g.name}
              </div>
              {g.items.map((s) => {
                const current = s.sessionId === currentId;
                const label = s.title?.trim() || s.sessionId.slice(0, 8);
                const when = fullDateTime(s.updatedAt);
                const tooltip = [current ? `${label} (current session)` : label, when, s.cwd ?? `Session id: ${s.sessionId}`].filter(Boolean).join("\n");
                return (
                  <div key={s.sessionId} class="popover-row">
                    <button type="button" role="option" aria-selected={current} class={`popover-item${current ? " selected" : ""}`} title={tooltip} onClick={() => load(s.sessionId)}>
                      <span class="popover-item-check">
                        <Icon name={current ? "check" : "comment-discussion"} />
                      </span>
                      <span class="popover-item-main">
                        <span class="popover-item-label">{label}</span>
                        {s.updatedAt && <span class="popover-item-desc">{relativeTime(s.updatedAt, now)}</span>}
                      </span>
                    </button>
                    <span class="popover-row-actions">
                      <IconButton
                        icon="edit"
                        label="Rename session"
                        onClick={() => {
                          close();
                          post({ type: "session.rename", sessionId: s.sessionId });
                        }}
                      />
                      <IconButton icon="copy" label={`Copy session id ${s.sessionId}`} onClick={() => post({ type: "copy", text: s.sessionId })} />
                      <IconButton icon="eye-closed" label="Hide from history" onClick={() => post({ type: "session.hide", sessionId: s.sessionId })} />
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
