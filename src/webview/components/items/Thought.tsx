import { memo } from "preact/compat";
import type { ThoughtItem } from "../../../shared/protocol";
import { formatDuration } from "../../format";
import { Markdown } from "../Markdown";
import { Icon, Spinner, useExpanded } from "../ui";

export const Thought = memo(function Thought({ item }: { item: ThoughtItem }) {
  const streaming = item.streaming && !item.replay;
  const [open, toggle] = useExpanded(`thought:${item.id}`, streaming);
  const elapsed = item.endedAt && !streaming && item.endedAt - item.createdAt >= 1000 ? formatDuration(item.endedAt - item.createdAt) : "";
  if (!item.text && !streaming) return null;
  return (
    <div class={`thought${streaming ? " streaming" : ""}${open ? " open" : ""}`} data-item-id={item.id}>
      <button type="button" class="thought-summary" aria-expanded={open} onClick={() => toggle()}>
        <Icon name={open ? "chevron-down" : "chevron-right"} class="disclosure-chevron" />
        {streaming ? <Spinner class="thought-icon" /> : <Icon name="lightbulb" class="thought-icon" />}
        <span class={`thought-label${streaming ? " shimmer" : ""}`}>{streaming ? "Thinking…" : "Thought"}</span>
        {elapsed && <span class="thought-elapsed">{elapsed}</span>}
      </button>
      {open && (
        <div class="thought-body">
          <Markdown text={item.text} streaming={streaming} />
        </div>
      )}
    </div>
  );
});
