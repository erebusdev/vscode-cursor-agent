import { memo } from "preact/compat";
import type { DividerItem, TurnEndItem } from "../../../shared/protocol";
import { formatDuration } from "../../format";
import { Icon } from "../ui";

function stopLabel(reason: string): { text: string; icon: string } {
  switch (reason) {
    case "cancelled":
      return { text: "Cancelled", icon: "debug-stop" };
    case "max_tokens":
      return { text: "Stopped: max tokens", icon: "warning" };
    case "max_turn_requests":
      return { text: "Stopped: max turn requests", icon: "warning" };
    case "refusal":
      return { text: "Refused", icon: "circle-slash" };
    case "error":
      return { text: "Stopped: error", icon: "error" };
    default:
      return { text: `Stopped: ${reason.replace(/_/g, " ")}`, icon: "info" };
  }
}

export const TurnEnd = memo(function TurnEnd({ item }: { item: TurnEndItem }) {
  if (item.stopReason === "end_turn") return <div class="turn-spacer" aria-hidden="true" />;
  const { text, icon } = stopLabel(item.stopReason);
  return (
    <div class={`turn-end reason-${item.stopReason}`} data-item-id={item.id}>
      <Icon name={icon} /> <span>{text}</span>
      {item.durationMs > 0 && <span class="turn-end-duration"> · {formatDuration(item.durationMs)}</span>}
    </div>
  );
});

export const Divider = memo(function Divider({ item }: { item: DividerItem }) {
  return (
    <div class="divider" role="separator" aria-label={item.text} data-item-id={item.id}>
      <span class="divider-text">{item.text}</span>
    </div>
  );
});
