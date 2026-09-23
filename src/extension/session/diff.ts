/**
 * Builds structured, display-ready diffs from ACP `diff` tool-call content.
 */
import { structuredPatch } from "diff";
import type { DiffHunk, DiffLine, FileDiff } from "../../shared/protocol";

const MAX_DIFF_LINES = 4000;

export interface RawDiffContent {
  readonly path: string;
  readonly oldText: string | null | undefined;
  readonly newText: string;
}

/**
 * Cursor reports newly created files with a synthetic git-style header:
 *   oldText: "-- /dev/null", newText: "++ b//abs/path\n<content>"
 * Normalise that back into (empty, content).
 */
export function normalizeCursorDiff(raw: RawDiffContent): { oldText: string; newText: string; isNew: boolean; isDeleted: boolean } {
  let oldText = raw.oldText ?? "";
  let newText = raw.newText ?? "";
  let isNew = false;
  let isDeleted = false;
  if (/^-{2,3} \/dev\/null\s*$/.test(oldText.trim())) {
    isNew = true;
    oldText = "";
    newText = newText.replace(/^\+{2,3} [^\n]*\n?/, "");
  }
  if (/^-{2,3} [^\n]*\n/.test(oldText) && /^\+{2,3} \/dev\/null\s*$/.test(newText.trim())) {
    isDeleted = true;
    oldText = oldText.replace(/^-{2,3} [^\n]*\n?/, "");
    newText = "";
  }
  if (raw.oldText === null || raw.oldText === undefined) {
    isNew = isNew || newText.length > 0;
  }
  return { oldText, newText, isNew, isDeleted };
}

export function buildFileDiff(raw: RawDiffContent, displayPath: string): FileDiff {
  const { oldText, newText, isNew, isDeleted } = normalizeCursorDiff(raw);
  const patch = structuredPatch(raw.path, raw.path, oldText, newText, undefined, undefined, { context: 3 });
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let emitted = 0;
  let truncated = false;
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines: DiffLine[] = [];
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === "+") {
        additions++;
        if (!truncated) lines.push({ type: "add", text, newLine });
        newLine++;
      } else if (marker === "-") {
        deletions++;
        if (!truncated) lines.push({ type: "del", text, oldLine });
        oldLine++;
      } else if (marker === "\\") {
        // "\ No newline at end of file" — skip.
      } else {
        if (!truncated) lines.push({ type: "context", text, oldLine, newLine });
        oldLine++;
        newLine++;
      }
      emitted++;
      if (emitted > MAX_DIFF_LINES) truncated = true;
    }
    if (lines.length > 0) {
      hunks.push({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines });
    }
  }
  return {
    path: raw.path,
    displayPath,
    hunks,
    additions,
    deletions,
    isNew,
    isDeleted,
    ...(truncated ? { truncated: true } : {}),
  };
}
