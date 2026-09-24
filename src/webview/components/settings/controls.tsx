/**
 * Building blocks of the settings tab: cards, rows (label + description on
 * the left, control on the right) and themed controls (switch, segmented
 * control, dropdown, text field).
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ExtensionSettings, SettingsKey } from "../../../shared/protocol";
import { post } from "../../vscode";
import { Icon } from "../ui";

export type Source = ExtensionSettings["sources"][string];
export type SettingValue = string | boolean | ReadonlyArray<string> | Readonly<Record<string, string>>;

const SOURCE_LABEL: Record<Exclude<Source, "default">, { text: string; hint: string }> = {
  user: { text: "User", hint: "Set in your user settings" },
  workspace: { text: "Workspace", hint: "Set in this workspace's settings, which override your user settings" },
  remote: { text: "Remote", hint: "Set in the remote machine's settings" },
};

export function updateSetting(key: SettingsKey, value: SettingValue): void {
  post({ type: "settings.update", key, value });
}

/** Shows "Saved" for a moment after a successful update. */
export function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = () => {
    setSaved(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(false), 1600);
  };
  return [saved, flash];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** A titled group of rows: small heading above a bordered card. */
export function SettingsGroup({ title, actions, children, id }: { title?: string; actions?: ComponentChildren; children: ComponentChildren; id?: string }) {
  const headingId = title ? `group-${id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : undefined;
  return (
    <section class="sgroup" aria-labelledby={headingId}>
      {(title || actions) && (
        <div class="sgroup-head">
          {title && (
            <h2 class="sgroup-title" id={headingId}>
              {title}
            </h2>
          )}
          {actions && <div class="sgroup-actions">{actions}</div>}
        </div>
      )}
      <div class="scard">{children}</div>
    </section>
  );
}

interface RowProps {
  /** Id of the control the label points at. */
  id: string;
  label: string;
  description?: ComponentChildren;
  /** When set, shows where the value comes from and offers a reset. */
  settingKey?: SettingsKey;
  source?: Source;
  saved?: boolean;
  /** Right-aligned control (switch, dropdown, segmented control, button). */
  control?: ComponentChildren;
  /** Wide right-aligned control (text field): wraps under the text when the row is narrow. */
  wide?: boolean;
  /** Full-width content under the label (lists, editors, status lines). */
  children?: ComponentChildren;
  /**
   * Whether the label names the control `id` (inputs, switches, dropdowns).
   * Off for action buttons and read-only content, which keep their own text as their name.
   */
  labelFor?: boolean;
}

export function SettingRow({ id, label, description, settingKey, source, saved, control, wide, children, labelFor = true }: RowProps) {
  const overridden = !!source && source !== "default";
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div class="srow">
      <div class={`srow-main${wide ? " wide" : ""}`}>
        <div class="srow-text">
          <div class="srow-label-line">
            {labelFor ? (
              <label class="srow-label" for={id}>
                {label}
              </label>
            ) : (
              <span class="srow-label" id={`${id}-label`}>
                {label}
              </span>
            )}
            {overridden && (
              <span class="srow-source" title={SOURCE_LABEL[source].hint}>
                {SOURCE_LABEL[source].text}
              </span>
            )}
            {overridden && settingKey && (
              <button type="button" class="srow-reset" title="Reset to the default value" onClick={() => post({ type: "settings.reset", key: settingKey })}>
                <Icon name="discard" /> Reset
              </button>
            )}
            <span class={`srow-saved${saved ? " show" : ""}`} aria-live="polite">
              {saved ? "Saved" : ""}
            </span>
          </div>
          {description && (
            <div class="srow-desc" id={descId}>
              {description}
            </div>
          )}
        </div>
        {control && <div class="srow-control">{control}</div>}
      </div>
      {children && <div class="srow-body">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** On/off switch. The row's label names it (via `id`). */
export function Toggle({ id, checked, onChange, describedBy }: { id: string; checked: boolean; onChange: (next: boolean) => void; describedBy?: string }) {
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-describedby={describedBy} class={`toggle${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
      <span class="toggle-thumb" aria-hidden="true" />
    </button>
  );
}

/** Small square checkbox (used by the model list, where rows are dense). */
export function Checkbox({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button id={id} type="button" role="checkbox" aria-checked={checked} aria-label={label} title={label} class={`checkbox${checked ? " checked" : ""}`} onClick={() => onChange(!checked)}>
      {checked && <Icon name="check" />}
    </button>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
}

/** Segmented control: a radio group of buttons; arrow keys move and select. */
export function Segmented<T extends string>({ id, value, options, onChange, label }: { id: string; value: T; options: ReadonlyArray<SegmentOption<T>>; onChange: (next: T) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (delta: number) => {
    const next = (index + delta + options.length) % options.length;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      class="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={i === index ? id : undefined}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          class={`segment${o.value === value ? " selected" : ""}`}
          title={o.hint}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Native dropdown, themed with the dropdown tokens. */
export function Select<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: ReadonlyArray<SegmentOption<T>>; onChange: (next: T) => void }) {
  return (
    <span class="select-wrap">
      <select id={id} class="sselect" value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" class="select-chevron" />
    </span>
  );
}

interface TextInputProps {
  id: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  ariaLabel?: string;
  onCommit: (next: string) => void;
}

/** Text input that commits on blur / Enter and reverts on Escape. */
export function CommitInput({ id, value, placeholder, mono, ariaLabel, onCommit }: TextInputProps) {
  const [draft, setDraft] = useState(value);
  // Latest draft, readable synchronously from event handlers (state may lag a render).
  const draftRef = useRef(value);
  const focused = useRef(false);
  const set = (v: string) => {
    draftRef.current = v;
    setDraft(v);
  };
  useEffect(() => {
    if (!focused.current) set(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = () => {
    if (draftRef.current !== value) onCommit(draftRef.current);
  };
  return (
    <input
      id={id}
      type="text"
      class={`text-input${mono ? " mono" : ""}`}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellcheck={false}
      onFocus={() => (focused.current = true)}
      onInput={(e) => set((e.currentTarget as HTMLInputElement).value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draftRef.current !== value) {
          e.stopPropagation();
          set(value);
        }
      }}
    />
  );
}
