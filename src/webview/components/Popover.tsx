import type { ComponentChildren, RefObject } from "preact";
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "./ui";

interface PopoverProps {
  anchor: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  children: ComponentChildren;
  label: string;
  role?: "dialog" | "menu" | "listbox";
  class?: string;
  align?: "start" | "end";
  minWidth?: number;
  /**
   * Move focus into the popover on open and back to the anchor on close.
   * Hover previews pass false so they never steal focus from the composer.
   */
  manageFocus?: boolean;
}

const FOCUSABLE = 'button:not([disabled]), [role="option"]:not([disabled]), [role="menuitem"]:not([disabled]), input:not([disabled]), a[href]';

type Placement = { left: number; top?: number; bottom?: number; maxHeight: number; maxWidth: number };

/**
 * Anchored popover (rendered in a portal). Positioned above the anchor when
 * there is room, otherwise below. Closes on Escape / outside click, supports
 * arrow-key roving focus and restores focus to the anchor on close.
 */
export function Popover(props: PopoverProps) {
  const { anchor, open, onClose, children, label, role = "dialog", align = "start", minWidth, manageFocus = true } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const compute = () => {
      const a = anchor.current;
      const p = ref.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pw = p.offsetWidth;
      const ph = p.offsetHeight;
      let left = align === "end" ? r.right - pw : r.left;
      left = Math.max(6, Math.min(left, vw - pw - 6));
      const spaceAbove = r.top - 8;
      const spaceBelow = vh - r.bottom - 8;
      const maxWidth = vw - 12;
      if (spaceAbove >= ph || spaceAbove >= spaceBelow) {
        setPlace({ left, bottom: vh - r.top + 4, maxHeight: Math.min(spaceAbove, vh * 0.7), maxWidth });
      } else {
        setPlace({ left, top: r.bottom + 4, maxHeight: Math.min(spaceBelow, vh * 0.7), maxWidth });
      }
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [open, anchor, align]);

  // Initial focus once placed.
  useEffect(() => {
    if (!open || !place || !manageFocus) return;
    const p = ref.current;
    if (!p) return;
    const preferred =
      p.querySelector<HTMLElement>("[data-autofocus]") ??
      p.querySelector<HTMLElement>('[aria-selected="true"], [aria-checked="true"]') ??
      p.querySelector<HTMLElement>(FOCUSABLE);
    (preferred ?? p).focus({ preventScroll: true });
    preferred?.scrollIntoView?.({ block: "nearest" });
  }, [open, place !== null, manageFocus]);

  // Outside click + focus restore.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      if (!manageFocus) return;
      const active = document.activeElement;
      if (!active || active === document.body || ref.current?.contains(active)) {
        anchor.current?.focus({ preventScroll: true });
      }
    };
  }, [open, anchor, manageFocus]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    const p = ref.current;
    if (!p) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      // Keep focus inside; closing on tab-out feels wrong in a sidebar.
      const items = Array.from(p.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : idx >= items.length - 1 ? 0 : idx + 1;
      e.preventDefault();
      items[next]?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      const all = Array.from(p.querySelectorAll<HTMLElement>(FOCUSABLE));
      const rows = all.filter((el) => el.tagName !== "INPUT");
      const items = rows.length ? rows : all;
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      let next: number;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else if (e.key === "ArrowDown") next = idx < 0 || idx >= items.length - 1 ? 0 : idx + 1;
      else next = idx <= 0 ? items.length - 1 : idx - 1;
      e.preventDefault();
      items[next]?.focus();
      items[next]?.scrollIntoView?.({ block: "nearest" });
    }
  };

  const style: Record<string, string | number> = {
    left: place ? place.left : 0,
    maxHeight: place ? place.maxHeight : undefined!,
    maxWidth: place ? place.maxWidth : undefined!,
    visibility: place ? "visible" : "hidden",
  };
  if (place?.top !== undefined) style.top = place.top;
  if (place?.bottom !== undefined) style.bottom = place.bottom;
  if (minWidth) style.minWidth = minWidth;

  return createPortal(
    <div ref={ref} class={`popover${props.class ? ` ${props.class}` : ""}`} role={role} aria-label={label} tabIndex={-1} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>,
    document.body,
  );
}

export interface ListOption {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  icon?: string;
}

interface PopoverListProps {
  options: ReadonlyArray<ListOption>;
  onSelect: (id: string) => void;
  emptyText?: string;
  role?: "listbox" | "menu";
}

/** A vertical list of selectable rows for use inside a Popover. */
export function PopoverList({ options, onSelect, emptyText = "No results", role = "listbox" }: PopoverListProps) {
  const itemRole = role === "menu" ? "menuitem" : "option";
  return (
    <div class="popover-list" role={role}>
      {options.length === 0 && <div class="popover-empty">{emptyText}</div>}
      {options.map((o) => (
        <button title={o.description ?? o.label}
          key={o.id}
          type="button"
          role={itemRole}
          class={`popover-item${o.selected ? " selected" : ""}`}
          aria-selected={itemRole === "option" ? !!o.selected : undefined}
          disabled={o.disabled}
          onClick={() => onSelect(o.id)}
        >
          <span class="popover-item-check">{o.selected ? <Icon name="check" /> : o.icon ? <Icon name={o.icon} /> : null}</span>
          <span class="popover-item-main">
            <span class="popover-item-label">{o.label}</span>
            {o.description && <span class="popover-item-desc">{o.description}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
