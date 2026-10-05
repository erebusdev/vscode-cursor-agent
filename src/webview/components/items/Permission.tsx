import { useEffect, useRef } from "preact/hooks";
import type { PermissionOption, PermissionState } from "../../../shared/protocol";
import { post } from "../../vscode";
import { Icon } from "../ui";

function labelFor(o: PermissionOption): string {
  switch (o.kind) {
    case "allow_once":
      return "Allow";
    case "allow_always":
      return "Always allow";
    case "reject_once":
      return "Reject";
    case "reject_always":
      return "Always reject";
    default:
      return o.name;
  }
}

/** Allow is primary, Always allow secondary, Reject/Always reject tertiary (quiet). */
function classFor(o: PermissionOption): string {
  if (o.kind === "allow_once") return "button primary";
  if (o.kind === "allow_always") return "button secondary";
  return "button tertiary";
}

export function respondToPermission(perm: PermissionState, kind: PermissionOption["kind"], scope?: "session"): boolean {
  const opt = perm.options.find((o) => o.kind === kind);
  if (!opt) return false;
  post({ type: "permission.respond", requestId: perm.requestId, optionId: opt.optionId, ...(scope ? { scope } : {}) });
  return true;
}

export function PermissionPrompt({ permission }: { permission: PermissionState }) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const pending = permission.state === "pending";

  useEffect(() => {
    if (pending) primaryRef.current?.focus({ preventScroll: false });
  }, [pending, permission.requestId]);

  if (!pending) {
    const chosen = permission.options.find((o) => o.optionId === permission.selectedOptionId);
    const text =
      permission.state === "cancelled"
        ? "Cancelled"
        : permission.resolution === "auto"
          ? "Auto-approved"
          : permission.resolution === "session"
            ? "Allowed for session"
            : chosen?.kind === "allow_once"
              ? "Allowed"
              : chosen?.kind === "allow_always"
                ? "Always allowed"
                : chosen?.kind === "reject_once" || chosen?.kind === "reject_always"
                  ? "Rejected"
                  : chosen?.name ?? "Resolved";
    const icon = text.startsWith("Allow") || text.startsWith("Always allow") || text.startsWith("Auto") ? "check" : text === "Cancelled" ? "circle-slash" : "close";
    return (
      <div class={`permission-resolved ${text.startsWith("Reject") ? "rejected" : ""}`}>
        <Icon name={icon} /> {text}
      </div>
    );
  }

  const allowOnce = permission.options.find((o) => o.kind === "allow_once");
  const allowAlways = permission.options.find((o) => o.kind === "allow_always");
  const rejects = permission.options.filter((o) => o.kind === "reject_once" || o.kind === "reject_always");
  const others = permission.options.filter((o) => !["allow_once", "allow_always", "reject_once", "reject_always"].includes(o.kind));
  const respond = (o: PermissionOption, scope?: "session") => post({ type: "permission.respond", requestId: permission.requestId, optionId: o.optionId, ...(scope ? { scope } : {}) });

  return (
    <div class="permission" role="group" aria-label="Permission request">
      <div class="permission-title">
        <Icon name="shield" /> <span>Permission required</span>
      </div>
      {permission.reason && <div class="permission-reason">{permission.reason}</div>}
      <div class="permission-actions">
        {allowOnce && (
          <button type="button" ref={primaryRef} class="button primary" title="Allow this once" onClick={() => respond(allowOnce)}>
            Allow
          </button>
        )}
        {allowOnce && (
          <button type="button" class="button secondary" title="Allow this command or tool for the rest of this session (nothing is saved)" onClick={() => respond(allowOnce, "session")}>
            Allow for session
          </button>
        )}
        {others.map((o) => (
          <button key={o.optionId} type="button" class="button secondary" title={o.name} onClick={() => respond(o)}>
            {o.name}
          </button>
        ))}
        {rejects.map((o) => (
          <button key={o.optionId} type="button" class="button tertiary" title={o.name} onClick={() => respond(o)}>
            {labelFor(o)}
          </button>
        ))}
        {allowAlways && (
          <button type="button" class="button tertiary permission-always" title="Saves this command permanently to Cursor's own permission config for your account" onClick={() => respond(allowAlways)}>
            Always allow
          </button>
        )}
      </div>
      <div class="permission-hint">
        <kbd>Y</kbd> allow · <kbd>S</kbd> for session · <kbd>N</kbd> reject
      </div>
    </div>
  );
}
