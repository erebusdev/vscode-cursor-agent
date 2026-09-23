import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectionState } from "../../shared/protocol";
import { pluralize, relativeTime } from "../format";
import { setSettingsOpen, useSelector } from "../store";
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
        <span class="header-title" title={title}>
          {title}
        </span>
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
          <UsageButton />
          <IconButton icon="add" label="New session" onClick={() => post({ type: "session.new" })} />
          <HistoryButton />
          <SettingsGear />
        </span>
      </div>
    </header>
  );
}

function SettingsGear() {
  const open = useSelector((s) => s.settingsOpen);
  const ref = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  // Return focus to the gear when the panel closes.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const active = document.activeElement;
      if (!active || active === document.body) ref.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  return <IconButton ref={ref} icon="settings-gear" label="Settings" class={open ? "active" : ""} aria-pressed={open} onClick={() => setSettingsOpen(!open)} />;
}

function HistoryButton() {
  const sessions = useSelector((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const openMenu = () => {
    post({ type: "session.list" });
    setOpen(true);
  };
  return (
    <>
      <IconButton ref={anchor} icon="history" label="Session history" aria-haspopup="listbox" aria-expanded={open} onClick={() => (open ? setOpen(false) : openMenu())} />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Session history" role="listbox" align="end" minWidth={260} class="history-popover">
        <div class="popover-heading">
          Recent sessions {sessions.loading && <Spinner class="section-spinner" />}
        </div>
        {sessions.error && <div class="popover-empty error">{sessions.error}</div>}
        {!sessions.loading && !sessions.error && sessions.list.length === 0 && <div class="popover-empty">No sessions yet.</div>}
        <div class="popover-list">
          {sessions.list.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              role="option"
              aria-selected={false}
              class="popover-item"
              title={s.cwd ?? s.sessionId}
              onClick={() => {
                setOpen(false);
                post({ type: "session.load", sessionId: s.sessionId });
              }}
            >
              <span class="popover-item-check">
                <Icon name="comment-discussion" />
              </span>
              <span class="popover-item-main">
                <span class="popover-item-label">{s.title?.trim() || s.sessionId.slice(0, 8)}</span>
                {s.updatedAt && <span class="popover-item-desc">{relativeTime(s.updatedAt)}</span>}
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

