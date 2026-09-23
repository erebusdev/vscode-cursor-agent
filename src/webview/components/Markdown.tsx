import { memo } from "preact/compat";
import { useMemo } from "preact/hooks";
import { renderMarkdown } from "../markdown";
import { post } from "../vscode";

interface MarkdownProps {
  text: string;
  streaming?: boolean;
  class?: string;
}

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const copyBtn = target.closest<HTMLButtonElement>(".md-code-copy");
  if (copyBtn) {
    e.preventDefault();
    const code = copyBtn.closest(".md-code")?.querySelector("code")?.textContent ?? "";
    post({ type: "copy", text: code });
    const icon = copyBtn.querySelector("i");
    if (icon) {
      icon.className = "codicon codicon-check";
      setTimeout(() => (icon.className = "codicon codicon-copy"), 1200);
    }
    return;
  }
  const a = target.closest<HTMLAnchorElement>("a[href]");
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?|mailto|vscode|vscode-insiders):/i.test(href)) {
      post({ type: "openExternal", url: href });
    } else if (href && !href.startsWith("#")) {
      // Relative/absolute path, optionally with :line suffix.
      const m = /^(.*?)(?::(\d+))?$/.exec(href);
      post({ type: "openFile", path: m?.[1] ?? href, line: m?.[2] ? Number(m[2]) : undefined });
    }
  }
}

/** Sanitised markdown. Code blocks have copy buttons; links are routed to the host. */
export const Markdown = memo(function Markdown({ text, streaming, class: cls }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      class={`markdown${streaming ? " streaming" : ""}${cls ? ` ${cls}` : ""}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={onClick}
    />
  );
});
