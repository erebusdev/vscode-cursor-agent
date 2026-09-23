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

function classFor(o: PermissionOption): string {
  if (o.kind === "allow_once") return "button primary";
  if (o.kind === "reject_once" || o.kind === "reject_always") return "button danger";
  return "button secondary";
}

export function respondToPermission(perm: PermissionState, kind: PermissionOption["kind"]): boolean {
  const opt = perm.options.find((o) => o.kind === kind);
  if (!opt) return false;
  post({ type: "permission.respond", requestId: perm.requestId, optionId: opt.optionId });
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
        : chosen?.kind === "allow_once"
          ? "Allowed"
          : chosen?.kind === "allow_always"
            ? "Always allowed"
            : chosen?.kind === "reject_once" || chosen?.kind === "reject_always"
              ? "Rejected"
              : chosen?.name ?? "Resolved";
    const icon = text.startsWith("Allow") || text.startsWith("Always allow") ? "check" : text === "Cancelled" ? "circle-slash" : "close";
    return (
      <div class={`permission-resolved ${text.startsWith("Reject") ? "rejected" : ""}`}>
        <Icon name={icon} /> {text}
      </div>
    );
  }

  // Order: allow_once, allow_always, reject_once, reject_always
  const order: Record<PermissionOption["kind"], number> = { allow_once: 0, allow_always: 1, reject_once: 2, reject_always: 3 };
  const options = [...permission.options].sort((a, b) => order[a.kind] - order[b.kind]);
  const primary = options.find((o) => o.kind === "allow_once") ?? options[0];

  return (
    <div class="permission" role="group" aria-label="Permission request">
      <div class="permission-title">
        <Icon name="shield" /> <span>Permission required</span>
      </div>
      {permission.reason && <div class="permission-reason">{permission.reason}</div>}
      <div class="permission-actions">
        {options.map((o) => (
          <button
            key={o.optionId}
            type="button"
            ref={o === primary ? primaryRef : undefined}
            class={classFor(o)}
            title={o.name}
            onClick={() => post({ type: "permission.respond", requestId: permission.requestId, optionId: o.optionId })}
          >
            {labelFor(o)}
          </button>
        ))}
      </div>
      <div class="permission-hint">
        <kbd>Y</kbd> allow · <kbd>A</kbd> always · <kbd>N</kbd> reject
      </div>
    </div>
  );
}
