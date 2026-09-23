import type { ComponentChildren, JSX } from "preact";
import { forwardRef } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { getExpandedOverride, setExpandedOverride } from "../store";

export function Spinner({ class: cls }: { class?: string }) {
  return <i class={`codicon codicon-loading codicon-modifier-spin${cls ? ` ${cls}` : ""}`} aria-hidden="true" />;
}

export function Icon({ name, class: cls, title }: { name: string; class?: string; title?: string }) {
  return <i class={`codicon codicon-${name}${cls ? ` ${cls}` : ""}`} aria-hidden={title ? undefined : "true"} title={title} />;
}

type ButtonProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, "icon" | "label" | "ref"> & { icon: string; label: string; class?: string };

/** Icon-only button with an accessible label and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(function IconButton({ icon, label, class: cls, children, ...rest }, ref) {
  return (
    <button ref={ref} type="button" class={`icon-button${cls ? ` ${cls}` : ""}`} title={label} aria-label={label} {...rest}>
      <Icon name={icon} />
      {children}
    </button>
  );
});

/** Ticks every `intervalMs` while `active`, returning Date.now(). */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

/**
 * Expanded state with a persisted user override. When the user has not
 * toggled it, the default is used (and may change as the item's status does).
 */
export function useExpanded(key: string, defaultExpanded: boolean): [boolean, (next?: boolean) => void] {
  const [override, setOverride] = useState<boolean | undefined>(() => getExpandedOverride(key));
  const value = override ?? defaultExpanded;
  const toggle = (next?: boolean) => {
    const v = next ?? !value;
    setOverride(v);
    setExpandedOverride(key, v);
  };
  return [value, toggle];
}

interface DisclosureProps {
  label: string;
  children: ComponentChildren;
  defaultOpen?: boolean;
  class?: string;
  icon?: string;
  summaryRight?: ComponentChildren;
}

/** Small "▸ Label" toggle with collapsible content. */
export function Disclosure({ label, children, defaultOpen = false, class: cls, icon, summaryRight }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div class={`disclosure${open ? " open" : ""}${cls ? ` ${cls}` : ""}`}>
      <button type="button" class="disclosure-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} class="disclosure-chevron" />
        {icon && <Icon name={icon} />}
        <span class="disclosure-label">{label}</span>
        {summaryRight && <span class="disclosure-right">{summaryRight}</span>}
      </button>
      {open && <div class="disclosure-body">{children}</div>}
    </div>
  );
}

export function Badge({ children, class: cls, title }: { children: ComponentChildren; class?: string; title?: string }) {
  return (
    <span class={`badge${cls ? ` ${cls}` : ""}`} title={title}>
      {children}
    </span>
  );
}

/** "+3 −1" style change counts. */
export function ChangeCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span class="change-counts" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span class="added">+{additions}</span> <span class="deleted">−{deletions}</span>
    </span>
  );
}

/** True when the user prefers reduced motion (checked lazily; cheap to call). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const PRE_PIN_THRESHOLD = 8;

/**
 * Output <pre> that follows appended content while `follow` is set, unless the
 * user has scrolled up inside it. Layout is contained (see `.output-pre`) so
 * a large, growing output does not re-layout the transcript around it.
 */
export function AutoScrollPre({ content, follow, class: cls, maxHeight }: { content: string; follow: boolean; class?: string; maxHeight?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow && pinned.current) el.scrollTop = el.scrollHeight;
  }, [content, follow]);
  const onScroll = () => {
    const el = ref.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PRE_PIN_THRESHOLD;
  };
  return (
    <pre ref={ref} class={`output-pre${cls ? ` ${cls}` : ""}`} style={maxHeight ? { maxHeight } : undefined} tabIndex={0} onScroll={follow ? onScroll : undefined}>
      {content}
    </pre>
  );
}

/** Cursor's cube mark, inline so it follows the current text colour. */
export function CursorMark({ size = 22, class: cls }: { size?: number; class?: string }) {
  return (
    <svg class={cls} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" fill-rule="evenodd" d="M12.00 0.50 L21.96 6.25 L21.96 17.75 L12.00 23.50 L2.04 17.75 L2.04 6.25 Z M2.04 6.25 L21.96 6.25 L12.00 23.50 L12.00 12.00 Z" />
    </svg>
  );
}
