import { marked, type Tokens } from "marked";
import DOMPurify, { type Config } from "dompurify";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code(this: unknown, token: Tokens.Code): string {
      const language = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
      const cls = language ? ` class="language-${escapeHtml(language)}"` : "";
      return (
        `<div class="md-code">` +
        `<div class="md-code-header"><span class="md-code-lang">${escapeHtml(language || "text")}</span>` +
        `<button type="button" class="md-code-copy icon-button" title="Copy code" aria-label="Copy code"><i class="codicon codicon-copy"></i></button></div>` +
        `<pre><code${cls}>${escapeHtml(token.text)}</code></pre></div>`
      );
    },
  },
});

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe", "object", "embed"],
  ADD_ATTR: ["align"],
};

/** Markdown -> sanitised HTML string. Safe to inject with innerHTML. */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  let html: string;
  try {
    html = marked.parse(text, { async: false }) as string;
  } catch {
    html = `<p>${escapeHtml(text)}</p>`;
  }
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
