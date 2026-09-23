import { relativeTime } from "../format";
import { useSelector } from "../store";
import { post } from "../vscode";
import { Icon, Spinner, useNow } from "./ui";

export function Welcome() {
  const sessions = useSelector((s) => s.sessions);
  const connection = useSelector((s) => s.session.connection);
  const lastError = useSelector((s) => s.session.lastError);
  const now = useNow(true, 30_000);
  const isMac = /Mac/i.test(navigator.platform);
  const sendKey = useSelector((s) => s.settings.sendWithCtrlEnter) ? (isMac ? "⌘↩" : "Ctrl+↩") : "↩";
  const newlineKey = useSelector((s) => s.settings.sendWithCtrlEnter) ? "↩" : "⇧↩";

  return (
    <div class="welcome">
      <div class="welcome-hero">
        <span class="welcome-logo">
          <Icon name="sparkle" />
        </span>
        <h2>Cursor Agent</h2>
        <p class="welcome-hint">
          <kbd>{sendKey}</kbd> to send · <kbd>{newlineKey}</kbd> for a new line · <kbd>/</kbd> for commands
        </p>
        {(connection === "starting" || connection === "loading") && (
          <p class="welcome-status">
            <Spinner /> {connection === "starting" ? "Starting agent…" : "Loading history…"}
          </p>
        )}
        {(connection === "error" || connection === "disconnected") && (
          <p class="welcome-status error">
            <Icon name="error" /> {lastError ?? (connection === "error" ? "The agent failed to start." : "The agent disconnected.")}{" "}
            <button type="button" class="link-button" onClick={() => post({ type: "session.reconnect" })}>
              Reconnect
            </button>
          </p>
        )}
      </div>

      <div class="recent-sessions">
        <div class="section-label">
          Recent sessions
          {sessions.loading && <Spinner class="section-spinner" />}
        </div>
        {sessions.error && <div class="recent-error">{sessions.error}</div>}
        {!sessions.loading && !sessions.error && sessions.list.length === 0 && <div class="recent-empty muted">No previous sessions for this workspace.</div>}
        <ul class="recent-list">
          {sessions.list.map((s) => (
            <li key={s.sessionId}>
              <button type="button" class="recent-row" onClick={() => post({ type: "session.load", sessionId: s.sessionId })} title={s.cwd ?? s.sessionId}>
                <Icon name="comment-discussion" class="recent-icon" />
                <span class="recent-title">{s.title?.trim() || s.sessionId.slice(0, 8)}</span>
                <span class="recent-time">{relativeTime(s.updatedAt, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
