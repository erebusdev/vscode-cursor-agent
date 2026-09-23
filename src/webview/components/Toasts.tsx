import { dismissToast, useSelector } from "../store";
import { Icon, IconButton } from "./ui";

const ICON = { info: "info", warning: "warning", error: "error" } as const;

export function Toasts() {
  const toasts = useSelector((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div class="toasts" aria-live="assertive">
      {toasts.map((t) => (
        <div key={t.id} class={`toast level-${t.level}`} role={t.level === "error" ? "alert" : "status"}>
          <Icon name={ICON[t.level]} />
          <span class="toast-text">{t.text}</span>
          <IconButton icon="close" label="Dismiss" class="toast-close" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}
