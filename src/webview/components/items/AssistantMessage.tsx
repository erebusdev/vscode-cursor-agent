import { memo } from "preact/compat";
import type { AssistantItem } from "../../../shared/protocol";
import { Markdown } from "../Markdown";

export const AssistantMessage = memo(function AssistantMessage({ item }: { item: AssistantItem }) {
  const streaming = item.streaming && !item.replay;
  if (!item.text && !streaming) return null;
  return (
    <div class="assistant-message" data-item-id={item.id}>
      <Markdown text={item.text} streaming={streaming} />
    </div>
  );
});
