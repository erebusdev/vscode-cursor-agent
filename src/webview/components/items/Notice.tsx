import { memo } from "preact/compat";
import type { NoticeAction, NoticeItem } from "../../../shared/protocol";
import { post } from "../../vscode";
import { Disclosure, Icon } from "../ui";

const ACTIONS: Record<NoticeAction, { label: string; icon: string; send: () => void }> = {
  reconnect: { label: "Reconnect", icon: "refresh", send: () => post({ type: "session.reconnect" }) },
  retry: { label: "Retry", icon: "debug-restart", send: () => post({ type: "session.reconnect" }) },
  newSession: { label: "New session", icon: "add", send: () => post({ type: "session.new" }) },
  openSettings: { label: "Settings", icon: "settings-gear", send: () => post({ type: "openSettings" }) },
  openLogs: { label: "Logs", icon: "output", send: () => post({ type: "openLogs" }) },
};

const LEVEL_ICON = { info: "info", warning: "warning", error: "error" } as const;

export const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  return (
    <div class={`notice level-${item.level}`} role={item.level === "error" ? "alert" : "status"} data-item-id={item.id}>
      <Icon name={LEVEL_ICON[item.level]} class="notice-icon" />
      <div class="notice-main">
        <div class="notice-text">{item.text}</div>
        {item.detail && (
          <Disclosure label="Details" class="notice-details">
            <pre class="output-pre" tabIndex={0}>
              {item.detail}
            </pre>
          </Disclosure>
        )}
        {item.actions.length > 0 && (
          <div class="notice-actions">
            {item.actions.map((a) => {
              const def = ACTIONS[a];
              if (!def) return null;
              return (
                <button title={def.label} key={a} type="button" class="button secondary small" onClick={def.send}>
                  <Icon name={def.icon} /> {def.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
