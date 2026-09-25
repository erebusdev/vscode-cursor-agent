import { memo } from "preact/compat";
import { useMemo, useState } from "preact/hooks";
import type { DiffLine, FileDiff } from "../../../shared/protocol";
import { post } from "../../vscode";
import { ChangeCounts, Icon, IconButton } from "../ui";

const COLLAPSE_AT = 200;

type Row = { kind: "hunk"; text: string; key: string } | { kind: "line"; line: DiffLine; key: string };

function flatten(diff: FileDiff): Row[] {
  const rows: Row[] = [];
  diff.hunks.forEach((h, hi) => {
    rows.push({ kind: "hunk", key: `h${hi}`, text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    h.lines.forEach((l, li) => rows.push({ kind: "line", line: l, key: `${hi}:${li}` }));
  });
  return rows;
}

interface Props {
  diff: FileDiff;
  /** Tool item id, used by `openDiff`. */
  itemId: string;
  defaultOpen?: boolean;
}

export const FileDiffView = memo(function FileDiffView({ diff, itemId, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => flatten(diff), [diff]);
  const tooLong = rows.length > COLLAPSE_AT;
  const visible = tooLong && !showAll ? rows.slice(0, COLLAPSE_AT) : rows;

  const openFile = () => post({ type: "openFile", path: diff.path });
  const openDiff = () => post({ type: "openDiff", itemId, path: diff.path });

  return (
    <div class="file-diff">
      <div class="file-diff-header">
        <button type="button" class="file-diff-toggle" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "Collapse" : "Expand"}>
          <Icon name={open ? "chevron-down" : "chevron-right"} class="disclosure-chevron" />
        </button>
        <button type="button" class="file-diff-path" onClick={openFile} title={`Open ${diff.path}`}>
          <Icon name={diff.isNew ? "diff-added" : diff.isDeleted ? "diff-removed" : "diff-modified"} class={`diff-kind ${diff.isNew ? "added" : diff.isDeleted ? "deleted" : "modified"}`} />
          <span class="file-diff-name">{diff.displayPath}</span>
        </button>
        <ChangeCounts additions={diff.additions} deletions={diff.deletions} />
        <span class="file-diff-actions">
          <IconButton icon="go-to-file" label="Open file" onClick={openFile} />
          <IconButton icon="diff" label="Open diff" onClick={openDiff} />
        </span>
      </div>
      {open && (
        <div class="diff-body" role="table" aria-label={`Diff for ${diff.displayPath}`}>
          {visible.map((r) =>
            r.kind === "hunk" ? (
              <div key={r.key} class="diff-line hunk" role="row">
                <span class="diff-gutter" /> <span class="diff-gutter" />
                <span class="diff-text">{r.text}</span>
              </div>
            ) : (
              <div key={r.key} class={`diff-line ${r.line.type}`} role="row">
                <span class="diff-gutter">{r.line.oldLine ?? ""}</span>
                <span class="diff-gutter">{r.line.newLine ?? ""}</span>
                <span class="diff-sign">{r.line.type === "add" ? "+" : r.line.type === "del" ? "−" : " "}</span>
                <span class="diff-text">{r.line.text}</span>
              </div>
            ),
          )}
          {tooLong && !showAll && (
            <button title="Show the whole diff" type="button" class="link-button diff-show-all" onClick={() => setShowAll(true)}>
              Show all {rows.length} lines
            </button>
          )}
          {diff.truncated && <div class="diff-truncated">Diff truncated — open the full diff to see everything.</div>}
        </div>
      )}
    </div>
  );
});
