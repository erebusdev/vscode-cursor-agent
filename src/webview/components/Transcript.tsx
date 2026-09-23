import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { findPendingPermission, getState, useSelector } from "../store";
import { ItemView } from "./items/ItemView";
import { respondToPermission } from "./items/Permission";
import { Icon } from "./ui";
import { Welcome } from "./Welcome";

type Group = { key: string; kind: "user" | "agent" | "solo"; ids: string[] };

/** Group consecutive agent-side items into one "turn" so they share a gutter. */
function groupIds(ids: ReadonlyArray<string>): Group[] {
  const items = getState().items;
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const id of ids) {
    const it = items.get(id);
    if (!it) continue;
    if (it.type === "user") {
      current = null;
      groups.push({ key: id, kind: "user", ids: [id] });
    } else if (it.type === "notice" || it.type === "divider") {
      current = null;
      groups.push({ key: id, kind: "solo", ids: [id] });
    } else {
      if (!current || current.kind !== "agent") {
        current = { key: id, kind: "agent", ids: [] };
        groups.push(current);
      }
      current.ids.push(id);
    }
  }
  return groups;
}

const BOTTOM_THRESHOLD = 48;

export function Transcript() {
  const ids = useSelector((s) => s.ids);
  const resetSeq = useSelector((s) => s.resetSeq);
  const ready = useSelector((s) => s.ready);
  const groups = useMemo(() => groupIds(ids), [ids]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showPill, setShowPill] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    setShowPill(false);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    atBottomRef.current = atBottom;
    if (atBottom) setShowPill(false);
  };

  // Follow content growth while pinned to the bottom.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      } else if (el.scrollHeight > el.clientHeight) {
        setShowPill(true);
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Jump to the bottom after a full reload and after the user sends a prompt.
  useLayoutEffect(() => {
    scrollToBottom();
  }, [resetSeq, ready]);
  useEffect(() => {
    const lastId = ids[ids.length - 1];
    const last = lastId ? getState().items.get(lastId) : undefined;
    if (last && last.type === "user" && !last.replay) scrollToBottom("smooth");
  }, [ids]);

  // Keyboard shortcuts for a pending permission when focus is not in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || t?.isContentEditable) return;
      if (t?.closest(".popover")) return;
      const pending = findPendingPermission();
      if (!pending) return;
      const perm = pending.options.permission;
      if (!perm) return;
      let handled = false;
      switch (e.key) {
        case "y":
        case "Y":
          handled = respondToPermission(perm, "allow_once");
          break;
        case "Enter":
          if (tag === "BUTTON") return; // let the focused button's click fire
          handled = respondToPermission(perm, "allow_once");
          break;
        case "a":
        case "A":
          handled = respondToPermission(perm, "allow_always");
          break;
        case "n":
        case "N":
        case "Escape":
          handled = respondToPermission(perm, "reject_once");
          break;
      }
      if (handled) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const empty = ids.length === 0;

  return (
    <div class="transcript-wrap">
      <div ref={scrollRef} class="transcript" role="log" aria-live="polite" aria-relevant="additions text" onScroll={onScroll} tabIndex={0}>
        <div ref={contentRef} class="transcript-content">
          {empty ? (
            <Welcome />
          ) : (
            groups.map((g) =>
              g.kind === "agent" ? (
                <div key={g.key} class="turn agent-turn">
                  <div class="turn-gutter" aria-hidden="true">
                    <span class="turn-avatar">
                      <Icon name="sparkle" />
                    </span>
                    <span class="turn-rule" />
                  </div>
                  <div class="turn-body">
                    {g.ids.map((id) => (
                      <ItemView key={id} id={id} />
                    ))}
                  </div>
                </div>
              ) : (
                <div key={g.key} class={`turn ${g.kind}-turn`}>
                  {g.ids.map((id) => (
                    <ItemView key={id} id={id} />
                  ))}
                </div>
              ),
            )
          )}
        </div>
      </div>
      {showPill && !empty && (
        <button type="button" class="new-messages-pill" onClick={() => scrollToBottom("smooth")}>
          <Icon name="arrow-down" /> New messages
        </button>
      )}
    </div>
  );
}
