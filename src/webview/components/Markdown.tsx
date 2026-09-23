import { memo } from "preact/compat";
import { useEffect, useLayoutEffect, useReducer, useRef } from "preact/hooks";
import { renderMarkdown } from "../markdown";
import { post } from "../vscode";

interface MarkdownProps {
  text: string;
  streaming?: boolean;
  class?: string;
}

/** Minimum interval between re-renders of a streaming message. */
const STREAM_INTERVAL_MS = 50;

const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const FENCE = /^ {0,3}(?:```|~~~)/;

/**
 * Index just past the last "safe" block boundary at or after `from`: a blank
 * line outside a code fence whose following line has started and cannot
 * continue the block before it. Only two things span a blank line: indented
 * continuation (next line starts with whitespace) and a list resuming with
 * another marker. Everything before a safe boundary renders identically on
 * its own, so it can be parsed once and cached while the tail streams.
 */
function lastSafeBoundary(text: string, from: number): number {
  let cut = from;
  let inFence = false;
  let inList = false;
  let prevBlank = true;
  let i = from;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    if (nl === -1) break;
    const line = text.slice(i, nl);
    const blank = line.trim() === "";
    if (FENCE.test(line)) {
      inFence = !inFence;
      inList = false;
    } else if (inFence || !blank) {
      if (!inFence) {
        if (LIST_MARKER.test(line)) inList = true;
        else if (prevBlank && !/^\s/.test(line)) inList = false;
      }
    } else if (i > from) {
      const ch = text.charCodeAt(nl + 1);
      const started = !Number.isNaN(ch);
      const indent = ch === 32 || ch === 9 || ch === 13 || ch === 10;
      const marker = ch === 45 || ch === 42 || ch === 43 || (ch >= 48 && ch <= 57);
      if (started && !indent && !(marker && inList)) cut = nl + 1;
    }
    prevBlank = blank;
    i = nl + 1;
  }
  return cut;
}

interface RenderCache {
  text: string;
  streaming: boolean;
  /** Length of the text prefix whose HTML is (or is queued to be) in the stable wrapper. */
  cut: number;
  /** HTML of completed blocks not yet appended to the stable wrapper. */
  pending: string[];
  /** Clear the stable wrapper before appending `pending`. */
  wipe: boolean;
  tail: string;
  at: number;
  timer: number;
}

function renderInto(c: RenderCache, text: string, streaming: boolean): void {
  if (!streaming) {
    c.cut = 0;
    c.pending = [];
    c.wipe = true;
    c.tail = renderMarkdown(text);
  } else {
    // Text is append-only while streaming; anything else invalidates the cache.
    if (!c.streaming || !text.startsWith(c.text)) {
      c.cut = 0;
      c.pending = [];
      c.wipe = true;
    }
    const cut = lastSafeBoundary(text, c.cut);
    if (cut > c.cut) {
      c.pending.push(renderMarkdown(text.slice(c.cut, cut)));
      c.cut = cut;
    }
    c.tail = renderMarkdown(text.slice(c.cut));
  }
  c.text = text;
  c.streaming = streaming;
}

/**
 * Markdown -> HTML with two optimisations for streaming: completed blocks are
 * parsed once and appended to a "stable" wrapper that preact never touches
 * again (so each tick re-parses and re-inserts only the trailing block), and
 * re-renders are throttled to `STREAM_INTERVAL_MS`. When streaming stops the
 * whole text is rendered once into the tail and the stable wrapper is cleared.
 */
function useStreamingMarkdown(text: string, streaming: boolean): RenderCache {
  const [, bump] = useReducer<number, void>((n) => n + 1, 0);
  const ref = useRef<RenderCache>({ text: "", streaming: false, cut: 0, pending: [], wipe: false, tail: "", at: 0, timer: 0 });
  const c = ref.current;
  if (c.text !== text || c.streaming !== streaming) {
    const now = performance.now();
    const due = now - c.at;
    if (!streaming || due >= STREAM_INTERVAL_MS) {
      renderInto(c, text, streaming);
      c.at = now;
      if (c.timer) {
        window.clearTimeout(c.timer);
        c.timer = 0;
      }
    } else if (!c.timer) {
      c.timer = window.setTimeout(() => {
        c.timer = 0;
        bump();
      }, STREAM_INTERVAL_MS - due);
    }
  }
  useEffect(() => () => window.clearTimeout(ref.current.timer), []);
  return c;
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
  const c = useStreamingMarkdown(text, !!streaming);
  const stableRef = useRef<HTMLDivElement>(null);
  // Completed blocks are appended imperatively; the wrapper has no children in the vnode tree.
  useLayoutEffect(() => {
    const el = stableRef.current;
    if (!el) return;
    if (c.wipe) {
      el.innerHTML = "";
      c.wipe = false;
    }
    if (c.pending.length) {
      el.insertAdjacentHTML("beforeend", c.pending.join(""));
      c.pending = [];
    }
  });
  return (
    <div class={`markdown${streaming ? " streaming" : ""}${cls ? ` ${cls}` : ""}`} onClick={onClick}>
      {/* Both wrappers are `display: contents`. */}
      <div ref={stableRef} class="md-stable" />
      {/* eslint-disable-next-line react/no-danger */}
      <div class="md-tail" dangerouslySetInnerHTML={{ __html: c.tail }} />
    </div>
  );
});
