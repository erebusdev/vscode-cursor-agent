/**
 * Hover tooltips that actually show up.
 *
 * Native `title` tooltips are unreliable inside VS Code webviews, so this
 * renders them itself: any element with a `title` gets its text moved to
 * `data-tooltip` on first hover (which also stops the browser trying), and a
 * small themed label appears near the element after a short delay. Works for
 * mouse hover and keyboard focus. Nothing else in the UI needs to change.
 */

const SHOW_DELAY_MS = 350;
const GAP = 6;

export function installTooltips(): void {
  const box = document.createElement("div");
  box.className = "ui-tooltip";
  box.setAttribute("role", "tooltip");
  box.hidden = true;
  document.body.appendChild(box);

  let timer: number | undefined;
  let current: HTMLElement | undefined;

  const textFor = (el: HTMLElement): string | undefined => {
    const title = el.getAttribute("title");
    if (title !== null) {
      // Keep the text where the browser will not render its own tooltip on top of ours.
      el.setAttribute("data-tooltip", title);
      el.removeAttribute("title");
    }
    const text = el.getAttribute("data-tooltip");
    return text && text.trim() ? text : undefined;
  };

  const hide = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    current = undefined;
    box.hidden = true;
  };

  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    box.style.left = "0px";
    box.style.top = "0px";
    box.hidden = false;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(4, Math.min(left, vw - w - 4));
    // Below the element by default; above when there is no room.
    let top = r.bottom + GAP;
    if (top + h > vh - 4) top = r.top - h - GAP;
    if (top < 4) top = 4;
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  };

  const schedule = (el: HTMLElement, delay: number) => {
    const text = textFor(el);
    if (!text) return;
    if (timer !== undefined) window.clearTimeout(timer);
    current = el;
    timer = window.setTimeout(() => {
      if (current !== el || !el.isConnected) return;
      // The text may have changed since scheduling (e.g. Show → Hide details).
      box.textContent = textFor(el) ?? text;
      place(el);
    }, delay);
  };

  const targetOf = (e: Event): HTMLElement | undefined => {
    const t = e.target as HTMLElement | null;
    return t?.closest?.("[title], [data-tooltip]") as HTMLElement | undefined;
  };

  document.addEventListener(
    "mouseover",
    (e) => {
      const el = targetOf(e);
      if (!el) return hide();
      if (el === current && !box.hidden) return;
      // Buttons with a hover card (data-hover-card) show the card on hover; the tooltip is for keyboard focus.
      if (el.hasAttribute("data-hover-card")) return hide();
      schedule(el, SHOW_DELAY_MS);
    },
    true,
  );
  document.addEventListener(
    "mouseout",
    (e) => {
      const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
      if (current && to && current.contains(to)) return;
      hide();
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const el = targetOf(e);
      if (!el) return hide();
      // Only for keyboard focus; a mouse click already hovers.
      if (el.matches(":focus-visible")) schedule(el, 0);
    },
    true,
  );
  document.addEventListener("focusout", hide, true);
  for (const type of ["mousedown", "keydown", "scroll", "wheel", "resize"]) {
    (type === "resize" ? window : document).addEventListener(type, hide, true);
  }
}
