import { lastSession, sessionLabel } from "../../shared/sessionHistory";
import { relativeTime } from "../format";
import { openHistory, resumeSession, useSelector } from "../store";
import { post } from "../vscode";
import { SetupCard, useNeedsSetup } from "./SetupCard";
import { CursorMark, Icon, Spinner } from "./ui";

/** The new-chat screen: a minimal hero, plus one quiet line to resume the last session or open the history. */
export function Welcome() {
  const sessions = useSelector((s) => s.sessions);
  const currentId = useSelector((s) => s.session.sessionId);
  const connection = useSelector((s) => s.session.connection);
  const lastError = useSelector((s) => s.session.lastError);
  const isMac = /Mac/i.test(navigator.platform);
  const sendKey = useSelector((s) => s.settings.sendWithCtrlEnter) ? (isMac ? "⌘↩" : "Ctrl+↩") : "↩";
  const newlineKey = useSelector((s) => s.settings.sendWithCtrlEnter) ? "↩" : "⇧↩";
  const needsSetup = useNeedsSetup();
  const last = lastSession(sessions.list, currentId);
  const failed = connection === "error" || connection === "disconnected";

  return (
    <div class="welcome">
      {needsSetup && <SetupCard />}
      <div class="welcome-hero">
        <span class="welcome-logo">
          <CursorMark size={22} />
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
        {!needsSetup && failed && (
          <p class="welcome-status error">
            <Icon name="error" /> {lastError ?? (connection === "error" ? "The agent failed to start." : "The agent disconnected.")}{" "}
            <button title="Try connecting to the agent again" type="button" class="link-button" onClick={() => post({ type: "session.reconnect" })}>
              Reconnect
            </button>
          </p>
        )}
        {!needsSetup && !failed && (
          <p class="welcome-actions">
            {last && (
              <>
                <button
                  type="button"
                  class="welcome-action"
                  title={`Resume “${sessionLabel(last)}”${last.updatedAt ? `, ${relativeTime(last.updatedAt)}` : ""}`}
                  onClick={() => resumeSession(last.sessionId)}
                >
                  <Icon name="debug-continue" />
                  <span>Resume</span>
                  <span class="welcome-action-title">{sessionLabel(last)}</span>
                </button>
                <span class="welcome-sep" aria-hidden="true">
                  ·
                </span>
              </>
            )}
            <button type="button" class="welcome-action" title="Open the session history" onClick={() => openHistory()}>
              <Icon name="history" />
              <span>History</span>
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
