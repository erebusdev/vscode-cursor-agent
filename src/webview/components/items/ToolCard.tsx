import { memo } from "preact/compat";
import type { ToolItem, ToolKind, ToolLocation } from "../../../shared/protocol";
import { formatDuration } from "../../format";
import { post } from "../../vscode";
import { AutoScrollPre, Badge, Disclosure, Icon, Spinner, useExpanded } from "../ui";
import { FileDiffView } from "./Diff";
import { PermissionPrompt } from "./Permission";

const KIND_ICON: Record<ToolKind, string> = {
  execute: "terminal",
  edit: "edit",
  read: "file",
  search: "search",
  fetch: "globe",
  delete: "trash",
  move: "arrow-right",
  think: "lightbulb",
  switch_mode: "arrow-swap",
  other: "tools",
};

function StatusIcon({ status }: { status: ToolItem["status"] }) {
  switch (status) {
    case "pending":
      return <span class="status-dot pending" title="Pending" aria-label="Pending" />;
    case "in_progress":
      return <Spinner class="status-spinner" />;
    case "completed":
      return <Icon name="check" class="status-ok" title="Completed" />;
    case "failed":
      return <Icon name="error" class="status-fail" title="Failed" />;
  }
}

function LocationChips({ locations }: { locations: ReadonlyArray<ToolLocation> }) {
  if (locations.length === 0) return null;
  return (
    <div class="chip-row">
      {locations.map((l, i) => (
        <button key={i} type="button" class="chip" title={l.path} onClick={() => post({ type: "openFile", path: l.path, line: l.line })}>
          <Icon name="file" />
          <span class="chip-label">
            {l.displayPath}
            {l.line ? `:${l.line}` : ""}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The header shows the command; the body repeats it only when the header would truncate it. */
function commandNeedsBody(item: ToolItem): boolean {
  return !!item.command && (item.command.includes("\n") || item.command.length > 72);
}

/** Anything worth expanding for. A pending permission prompt is rendered outside the body, so it does not count. */
function hasBody(item: ToolItem): boolean {
  const resolvedPermission = !!item.permission && item.permission.state !== "pending";
  return !!(commandNeedsBody(item) || item.output || item.diffs.length || item.locations.length || item.fileContent || item.inputText || resolvedPermission);
}

export const ToolCard = memo(function ToolCard({ item }: { item: ToolItem }) {
  const running = item.status === "in_progress" && !item.replay;
  const pendingPermission = item.permission?.state === "pending";
  const defaultExpanded = item.replay
    ? false
    : running || item.status === "pending" || pendingPermission || item.status === "failed" || (item.kind === "edit" && item.diffs.length > 0);
  const [open, toggle] = useExpanded(`tool:${item.id}`, defaultExpanded);
  const bodyAvailable = hasBody(item);
  const expanded = open && bodyAvailable;

  const isExec = item.kind === "execute";
  const primary = isExec && item.command ? item.command : item.title;
  const secondary = isExec && item.command ? (item.subtitle && item.subtitle !== item.command ? item.subtitle : undefined) : item.subtitle;
  const duration = item.endedAt && !item.replay && item.endedAt - item.createdAt >= 1000 ? formatDuration(item.endedAt - item.createdAt) : "";

  return (
    <div class={`tool-card kind-${item.kind} status-${item.status}${expanded ? " open" : ""}${pendingPermission ? " needs-permission" : ""}`} data-item-id={item.id}>
      <button title={bodyAvailable ? (expanded ? "Hide details" : "Show details") : undefined} type="button" class="tool-header" aria-expanded={bodyAvailable ? expanded : undefined} disabled={!bodyAvailable} onClick={() => toggle()}>
        <Icon name={KIND_ICON[item.kind] ?? "tools"} class="tool-kind-icon" />
        <span class={`tool-title${isExec && item.command ? " mono" : ""}`} title={primary}>
          {primary}
        </span>
        {secondary && (
          <span class="tool-subtitle" title={secondary}>
            {secondary}
          </span>
        )}
        <span class="tool-status">
          {duration && item.status !== "in_progress" && <span class="tool-duration">{duration}</span>}
          <StatusIcon status={item.status} />
          {bodyAvailable && <Icon name={expanded ? "chevron-up" : "chevron-down"} class="tool-chevron" />}
        </span>
      </button>

      {pendingPermission && item.permission && <PermissionPrompt permission={item.permission} />}

      {expanded && (
        <div class="tool-body">
          {item.permission && !pendingPermission && <PermissionPrompt permission={item.permission} />}

          {isExec && (
            <>
              {commandNeedsBody(item) && (
                <pre class="command-pre">
                  <span class="prompt-sign">$ </span>
                  {item.command}
                </pre>
              )}
              {(item.output || running) && <AutoScrollPre content={item.output} follow={running} maxHeight={300} class={running ? "running" : ""} />}
              {item.exitCode !== undefined && item.exitCode !== 0 && (
                <div class="tool-footer">
                  <Badge class="fail">exit {item.exitCode}</Badge>
                </div>
              )}
            </>
          )}

          {item.kind === "edit" && (
            <>
              {item.diffs.map((d, i) => (
                <FileDiffView key={`${d.path}:${i}`} diff={d} itemId={item.id} defaultOpen={!item.replay} />
              ))}
              {item.diffs.length === 0 && item.locations.length > 0 && <LocationChips locations={item.locations} />}
              {item.output && (item.status === "failed" || item.diffs.length === 0) && <AutoScrollPre content={item.output} follow={running} maxHeight={200} />}
            </>
          )}

          {item.kind === "read" && (
            <>
              <LocationChips locations={item.locations} />
              {item.fileContent && (
                <Disclosure label="File content" icon="file-code" defaultOpen={false}>
                  <pre class="output-pre file-content" tabIndex={0}>
                    {item.fileContent}
                  </pre>
                </Disclosure>
              )}
              {item.output && !item.fileContent && <AutoScrollPre content={item.output} follow={running} maxHeight={240} />}
            </>
          )}

          {!isExec && item.kind !== "edit" && item.kind !== "read" && (
            <>
              <LocationChips locations={item.locations} />
              {item.diffs.map((d, i) => (
                <FileDiffView key={`${d.path}:${i}`} diff={d} itemId={item.id} />
              ))}
              {item.output && <AutoScrollPre content={item.output} follow={running} maxHeight={300} />}
              {item.fileContent && (
                <Disclosure label="Content" icon="file-code">
                  <pre class="output-pre file-content" tabIndex={0}>
                    {item.fileContent}
                  </pre>
                </Disclosure>
              )}
            </>
          )}

          {item.inputText && !isExec && (
            <Disclosure label="Input" icon="json">
              <pre class="output-pre input-pre" tabIndex={0}>
                {item.inputText}
              </pre>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  );
});
