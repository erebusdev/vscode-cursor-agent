import { secondsSince } from "../format";
import { useSelector } from "../store";
import { Icon, Spinner, useNow } from "./ui";

export function WorkingIndicator() {
  const connection = useSelector((s) => s.session.connection);
  const turnStartedAt = useSelector((s) => s.session.turnStartedAt);
  const pendingPermissions = useSelector((s) => s.session.pendingPermissions);
  const active = connection === "running" || connection === "cancelling";
  const now = useNow(active);
  if (!active) return null;
  const elapsed = secondsSince(turnStartedAt, now);
  const waiting = pendingPermissions > 0;
  return (
    <div class={`working${waiting ? " waiting" : ""}`} role="status">
      {waiting ? <Icon name="shield" /> : <Spinner />}
      <span>
        {connection === "cancelling" ? "Cancelling…" : waiting ? "Waiting for your approval" : "Working…"}
        {turnStartedAt && !waiting && ` ${elapsed}s`}
      </span>
    </div>
  );
}
