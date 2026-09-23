import { memo } from "preact/compat";
import type { UserAttachment, UserItem } from "../../../shared/protocol";
import { post } from "../../vscode";
import { Icon } from "../ui";

function AttachmentChip({ a }: { a: UserAttachment }) {
  const openable = !!a.path && a.kind !== "image";
  const onClick = () => {
    if (openable && a.path) post({ type: "openFile", path: a.path, line: a.startLine });
  };
  if (a.kind === "image") {
    return (
      <span class="chip chip-image" title={a.label}>
        {a.previewDataUrl ? <img src={a.previewDataUrl} alt={a.label} /> : <Icon name="file-media" />}
        <span class="chip-label">{a.label}</span>
      </span>
    );
  }
  return (
    <button type="button" class="chip" onClick={onClick} disabled={!openable} title={a.path ?? a.label}>
      <Icon name={a.kind === "selection" ? "selection" : "file"} />
      <span class="chip-label">{a.label}</span>
    </button>
  );
}

export const UserMessage = memo(function UserMessage({ item }: { item: UserItem }) {
  return (
    <div class="user-message" data-item-id={item.id}>
      {item.attachments.length > 0 && (
        <div class="chip-row">
          {item.attachments.map((a, i) => (
            <AttachmentChip key={i} a={a} />
          ))}
        </div>
      )}
      <div class="user-text">{item.text}</div>
    </div>
  );
});
