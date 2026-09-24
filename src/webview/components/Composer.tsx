import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConfigOption, PromptAttachmentInput } from "../../shared/protocol";
import { clearAttachments, addAttachment, onComposerEvent, removeAttachment, openSettings, getState, useSelector } from "../store";
import { isAutoModel, visibleModels } from "../../shared/modelVisibility";
import { Toggle } from "./settings/controls";
import { getPersisted, persist, post } from "../vscode";
import { readImageFile } from "../attachments";
import { Popover, PopoverList } from "./Popover";
import { Icon, IconButton, Spinner } from "./ui";

const MAX_ROWS = 10;
const HISTORY_LIMIT = 50;
const DRAFT_DEBOUNCE = 300;
/** Auto-grow is done in CSS where `field-sizing` exists (Chromium 123+); the JS fallback measures once per edit. */
const CSS_FIELD_SIZING = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
const MENTION_DEBOUNCE = 120;

/** `@token` directly before the caret (at the start of the text or after whitespace). */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@(\S*)$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2]!.length - 1, query: m[2]! };
}

// ---------------------------------------------------------------------------
// Attachment chips
// ---------------------------------------------------------------------------

function AttachmentChips() {
  const attachments = useSelector((s) => s.attachments);
  if (attachments.length === 0) return null;
  return (
    <div class="chip-row composer-chips" aria-label="Attachments">
      {attachments.map((a, i) => (
        <span key={`${a.kind}:${a.label}:${i}`} class={`chip chip-removable${a.kind === "image" ? " chip-image" : ""}`} title={a.path ?? a.label}>
          {a.kind === "image" && a.data && a.mimeType ? <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.label} /> : <Icon name={a.kind === "selection" ? "selection" : a.kind === "image" ? "file-media" : "file"} />}
          <span class="chip-label">{a.label}</span>
          <button type="button" class="chip-remove" title="Remove attachment" aria-label={`Remove ${a.label}`} onClick={() => removeAttachment(i)}>
            <Icon name="close" />
          </button>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

function AddMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={anchor} icon="add" label="Add context" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} class="composer-add" />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Add context" role="menu" minWidth={180}>
        <PopoverList
          role="menu"
          options={[
            { id: "active", label: "Add active file", icon: "file" },
            { id: "pick", label: "Add files…", icon: "folder-opened" },
          ]}
          onSelect={(id) => {
            setOpen(false);
            post(id === "active" ? { type: "attachActiveFile" } : { type: "pickFiles" });
          }}
        />
      </Popover>
    </>
  );
}

function ModePicker() {
  const modes = useSelector((s) => s.session.modes);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!modes || modes.availableModes.length === 0) return null;
  const current = modes.availableModes.find((m) => m.id === modes.currentModeId);
  return (
    <>
      <button ref={anchor} type="button" class="picker" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title="Mode">
        <span class="picker-label">{current?.name ?? modes.currentModeId}</span>
        <Icon name="chevron-down" class="picker-chevron" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Mode" role="listbox" minWidth={200}>
        <PopoverList
          options={modes.availableModes.map((m) => ({ id: m.id, label: m.name, description: m.description, selected: m.id === modes.currentModeId }))}
          onSelect={(id) => {
            setOpen(false);
            if (id !== modes.currentModeId) post({ type: "mode.set", modeId: id });
          }}
        />
      </Popover>
    </>
  );
}

const APPROVAL_OPTIONS: ReadonlyArray<{ id: "ask" | "safe" | "auto"; label: string; description: string }> = [
  { id: "ask", label: "Ask", description: "Prompt for every command and tool call" },
  { id: "safe", label: "Safe list", description: "Read-only commands and tools run without asking" },
  { id: "auto", label: "Auto", description: "Run everything without asking (this session)" },
];

function ApprovalsPicker() {
  const policy = useSelector((s) => s.session.approvalPolicy);
  const allowed = useSelector((s) => s.session.sessionAllowed ?? []);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!policy) return null;
  const current = APPROVAL_OPTIONS.find((o) => o.id === policy) ?? APPROVAL_OPTIONS[0]!;
  return (
    <>
      <button ref={anchor} type="button" class={`picker approvals-picker policy-${policy}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title={`Approvals: ${current.description}${allowed.length ? ` · allowed this session: ${allowed.join(", ")}` : ""}`}>
        <Icon name={policy === "auto" ? "unlock" : "shield"} class="picker-icon" />
        <span class="picker-label">{current.label}</span>
        <Icon name="chevron-down" class="picker-chevron" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Approvals" role="listbox" minWidth={240}>
        <div class="popover-heading">Approvals</div>
        <PopoverList
          options={APPROVAL_OPTIONS.map((o) => ({ id: o.id, label: o.label, description: o.description, selected: o.id === policy }))}
          onSelect={(id) => {
            setOpen(false);
            if (id !== policy) post({ type: "approvals.set", policy: id as "ask" | "safe" | "auto" });
          }}
        />
        {allowed.length > 0 && <div class="popover-footnote">Allowed this session: {allowed.join(", ")}</div>}
      </Popover>
    </>
  );
}

function ModelPicker() {
  const models = useSelector((s) => s.session.models);
  const modelOptions = useSelector((s) => s.session.modelOptions);
  const visibility = useSelector((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  if (!models || models.availableModels.length === 0) return null;
  const current = models.availableModels.find((m) => m.modelId === models.currentModelId);
  // Fast, context and other model settings live here; reasoning has its own control next to the model.
  const modelSettings = modelOptions.filter((o) => !isReasoningOption(o));
  const fast = modelSettings.find((o) => isSwitchOption(o) && isFastOption(o));
  const fastOn = !!fast && isOn(fast);
  const context = modelSettings.find((o) => !isSwitchOption(o) && (/context/i.test(o.id) || /context/i.test(o.name)));
  // Auto is not a model in the list: it is a switch above it (Cursor picks the model per request).
  const auto = models.availableModels.find((m) => isAutoModel(m.modelId, m.name));
  const autoOn = !!auto && auto.modelId === models.currentModelId;
  const specific = models.availableModels.filter((m) => m !== auto);
  const shown = visibleModels(specific, models.currentModelId, visibility);
  const autoOffered = !!auto && (autoOn || !visibility.hiddenModels.includes(auto.modelId));
  const hiddenCount = specific.length - shown.length;
  const q = filter.trim().toLowerCase();
  const filtered = q ? shown.filter((m) => m.name.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q) || m.description?.toLowerCase().includes(q)) : shown;
  /** Model to return to when Auto is switched off: the last one used, else the default, else the first shown. */
  const manualModel = (): string | undefined => {
    const available = (id: string | undefined) => (id && specific.some((m) => m.modelId === id) ? id : undefined);
    return available(getState().lastManualModelId) ?? available(getState().extSettings?.defaultModel) ?? shown[0]?.modelId;
  };
  const setAuto = (on: boolean) => {
    if (!auto) return;
    const target = on ? auto.modelId : manualModel();
    if (target && target !== models.currentModelId) post({ type: "model.set", modelId: target });
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        class="picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={["Model", context ? `${optionValueLabel(context)} context` : "", fastOn ? "Fast mode on" : ""].filter(Boolean).join(" · ")}
      >
        {fastOn && <Icon name="zap" class="picker-fast" />}
        <span class="picker-label">{current?.name ?? models.currentModelId}</span>
        {context && <span class="picker-sub">· {optionValueLabel(context)}</span>}
        <Icon name="chevron-down" class="picker-chevron" />
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => {
          setOpen(false);
          setFilter("");
        }}
        label="Model"
        role="dialog"
        minWidth={240}
        class="model-popover"
      >
        {autoOffered && (
          <div class="model-auto-row">
            <label class="model-auto-text" for="model-auto-switch">
              <span class="model-auto-name">Auto</span>
              <span class="model-auto-desc">Cursor picks the model for each request</span>
            </label>
            <span title={autoOn ? "Turn Auto off and choose a model" : "Let Cursor pick the model for each request"}>
              <Toggle id="model-auto-switch" checked={autoOn} onChange={setAuto} />
            </span>
          </div>
        )}
        <input
          type="text"
          class="text-input popover-filter"
          placeholder="Filter models…"
          aria-label="Filter models"
          data-autofocus
          value={filter}
          onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered.length > 0) {
              const pick = filtered.find((m) => m.modelId === models.currentModelId && !q) ?? filtered[0];
              if (pick) {
                setOpen(false);
                setFilter("");
                if (pick.modelId !== models.currentModelId) post({ type: "model.set", modelId: pick.modelId });
              }
            }
          }}
        />
        <PopoverList
          options={filtered.map((m) => ({ id: m.modelId, label: m.name, description: m.description, selected: m.modelId === models.currentModelId }))}
          onSelect={(id) => {
            setOpen(false);
            setFilter("");
            if (id !== models.currentModelId) post({ type: "model.set", modelId: id });
          }}
          emptyText="No matching models"
        />
        {modelSettings.length > 0 && (
          <div class="model-options" role="group" aria-label={`Settings for ${current?.name ?? models.currentModelId}`}>
            {modelSettings.map((o) => (
              <OptionRow key={o.id} option={o} />
            ))}
          </div>
        )}
        <div class="popover-footer">
          <button title="Use this model and its options for new sessions" type="button" class="link-button" onClick={() => post({ type: "model.saveDefault" })}>
            <Icon name="pin" /> Set as default
          </button>
          <button title="Choose which models appear here"
            type="button"
            class="link-button"
            onClick={() => {
              setOpen(false);
              setFilter("");
              openSettings("models");
            }}
          >
            <Icon name="settings" /> Manage models…{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
          </button>
        </div>
      </Popover>
    </>
  );
}

function isSwitchOption(o: ConfigOption): boolean {
  return o.type === "boolean" || typeof o.currentValue === "boolean" || isTrueFalse(o.options.map((x) => x.value));
}

function isOn(o: ConfigOption): boolean {
  return o.currentValue === true || o.currentValue === "true";
}

const isFastOption = (o: ConfigOption) => /fast/i.test(o.id) || /fast/i.test(o.name);

/** Reasoning options (effort, reasoning level, thinking): they get their own control next to the model. */
function isReasoningOption(o: ConfigOption): boolean {
  return o.category === "thought_level" || /effort|reasoning|thinking/i.test(o.id) || /effort|reasoning|thinking/i.test(o.name);
}

/** The current model's reasoning level as its own control, like T3 Code: one click to open, one to choose. */
function ReasoningPicker() {
  const models = useSelector((s) => s.session.models);
  const modelOptions = useSelector((s) => s.session.modelOptions);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const reasoning = modelOptions.filter(isReasoningOption);
  if (reasoning.length === 0) return null;
  const modelName = models?.availableModels.find((m) => m.modelId === models.currentModelId)?.name ?? models?.currentModelId ?? "this model";
  const selects = reasoning.filter((o) => !isSwitchOption(o) && o.options.length > 0);
  const switches = reasoning.filter((o) => isSwitchOption(o) || o.options.length === 0);
  const parts = [...selects.map(optionValueLabel), ...switches.filter((o) => isSwitchOption(o) && !isOn(o) && selects.length === 0).map((o) => `No ${o.name.toLowerCase()}`), ...switches.filter((o) => isSwitchOption(o) && isOn(o) && selects.length === 0).map((o) => o.name)];
  const label = parts.join(" · ") || "Reasoning";
  return (
    <>
      <button ref={anchor} type="button" class="picker" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} title={`Reasoning for ${modelName}: ${reasoning.map((o) => `${o.name} ${optionValueLabel(o)}`).join(", ")}`}>
        <span class="picker-label">{label}</span>
        <Icon name="chevron-down" class="picker-chevron" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={`Reasoning for ${modelName}`} role="dialog" minWidth={180} class="reasoning-popover">
        {selects.map((o) => (
          <div key={o.id} class="traits-group" role="group" aria-label={o.name}>
            <div class="popover-subheading">{o.name}</div>
            <PopoverList
              options={o.options.map((x) => ({ id: x.value, label: x.name, description: x.description, selected: String(o.currentValue) === x.value }))}
              onSelect={(value) => {
                setOpen(false);
                if (value !== String(o.currentValue)) post({ type: "config.set", configId: o.id, value });
              }}
            />
          </div>
        ))}
        {switches.length > 0 && (
          <div class="model-options" role="group" aria-label="Reasoning switches">
            {switches.map((o) => (
              <OptionRow key={o.id} option={o} />
            ))}
          </div>
        )}
      </Popover>
    </>
  );
}

function optionValueLabel(o: ConfigOption): string {
  if (o.type === "boolean" || typeof o.currentValue === "boolean") return o.currentValue ? "On" : "Off";
  if (isTrueFalse(o.options.map((x) => x.value))) return o.currentValue === "true" ? "On" : "Off";
  const match = o.options.find((x) => x.value === o.currentValue);
  return match?.name ?? String(o.currentValue);
}



function isTrueFalse(values: ReadonlyArray<string>): boolean {
  return values.length === 2 && values.includes("true") && values.includes("false");
}

/** One option of the current model, edited in place inside the model popover. */
function OptionRow({ option }: { option: ConfigOption }) {
  const [text, setText] = useState(String(option.currentValue));
  const isBool = option.type === "boolean" || typeof option.currentValue === "boolean";
  // Cursor sends on/off options such as Fast and Thinking as a select of "true"/"false"; those get a switch too.
  const isTrueFalseSelect = !isBool && isTrueFalse(option.options.map((x) => x.value));
  const isSelect = !isBool && !isTrueFalseSelect && option.options.length > 0;
  const set = (value: string | boolean) => {
    if (value !== option.currentValue) post({ type: "config.set", configId: option.id, value });
  };
  if (isBool || isTrueFalseSelect) {
    const on = isBool ? option.currentValue === true : option.currentValue === "true";
    const id = `model-option-${option.id}`;
    return (
      <div class="model-option-row" title={option.description ?? option.name}>
        <label class="model-option-name" for={id}>
          {option.name}
        </label>
        <Toggle id={id} checked={on} onChange={(next) => set(isBool ? next : String(next))} />
      </div>
    );
  }
  return (
    <label class="model-option-row" title={option.description ?? option.name}>
      <span class="model-option-name">{option.name}</span>
      {isSelect ? (
        <select class="select-input" value={String(option.currentValue)} onChange={(e) => set((e.currentTarget as HTMLSelectElement).value)}>
          {option.options.map((x) => (
            <option key={x.value} value={x.value} title={x.description}>
              {x.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          class="text-input model-option-input"
          value={text}
          aria-label={option.name}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onBlur={() => set(text)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              set(text);
            }
          }}
        />
      )}
    </label>
  );
}

const QUEUE_DRAG_TYPE = "application/x-cursor-queue";

/** Messages waiting to go out after the current turn, in order. Rows can be dragged to reorder, or moved with the arrows. */
function QueuedBar() {
  const queued = useSelector((s) => s.session.queued);
  const running = useSelector((s) => s.session.connection === "running" || s.session.connection === "cancelling");
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  if (!queued || queued.length === 0) return null;
  const many = queued.length > 1;
  const targetFor = (e: DragEvent, i: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? i : i + 1;
  };
  const finishDrag = () => {
    setDragging(null);
    setDropAt(null);
  };
  return (
    <div class="queued-list" role="status" aria-label="Queued messages">
      {queued.map((q, i) => {
        const preview = q.text.trim().replace(/\s+/g, " ") || `${q.attachmentCount} attachment${q.attachmentCount === 1 ? "" : "s"}`;
        const indicator = dropAt === i ? " drop-before" : dropAt === i + 1 && i === queued.length - 1 ? " drop-after" : "";
        return (
          <div
            key={i}
            class={`queued-bar${dragging === i ? " dragging" : ""}${indicator}`}
            draggable={many}
            onDragStart={(e) => {
              if (!many || !e.dataTransfer) return;
              e.dataTransfer.setData(QUEUE_DRAG_TYPE, String(i));
              e.dataTransfer.effectAllowed = "move";
              setDragging(i);
            }}
            onDragEnd={finishDrag}
            onDragOver={(e) => {
              if (!e.dataTransfer?.types.includes(QUEUE_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropAt(targetFor(e, i));
            }}
            onDragLeave={() => setDropAt(null)}
            onDrop={(e) => {
              const raw = e.dataTransfer?.getData(QUEUE_DRAG_TYPE);
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              const from = Number(raw);
              let to = targetFor(e, i);
              if (to > from) to -= 1;
              finishDrag();
              if (Number.isFinite(from) && from !== to) post({ type: "queue.move", from, to });
            }}
          >
            <Icon name={many ? "gripper" : "list-ordered"} class={many ? "queued-grip" : ""} />
            <span class="queued-label">{i === 0 && !running ? "Queued (stopped)" : `#${i + 1}`}</span>
            <span class="queued-text" title={q.text}>
              {preview}
              {q.attachmentCount > 0 && q.text.trim() ? ` · ${q.attachmentCount} attachment${q.attachmentCount === 1 ? "" : "s"}` : ""}
            </span>
            <span class="queued-actions">
              {many && (
                <>
                  <IconButton icon="arrow-up" label="Move up" disabled={i === 0} onClick={() => post({ type: "queue.move", from: i, to: i - 1 })} />
                  <IconButton icon="arrow-down" label="Move down" disabled={i === queued.length - 1} onClick={() => post({ type: "queue.move", from: i, to: i + 1 })} />
                </>
              )}
              <button type="button" class="link-button" title="Interrupt the current turn and send this now" onClick={() => post({ type: "queue.sendNow", index: i })}>
                Send now
              </button>
              <button type="button" class="link-button" title="Put it back in the composer" onClick={() => post({ type: "queue.edit", index: i })}>
                Edit
              </button>
              <IconButton icon="close" label="Remove queued message" onClick={() => post({ type: "queue.clear", index: i })} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Composer() {
  const session = useSelector((s) => s.session);
  const settings = useSelector((s) => s.settings);
  const attachments = useSelector((s) => s.attachments);
  const hostDraft = useSelector((s) => s.hostDraft);

  const [text, setTextState] = useState<string>(() => getPersisted().draft ?? "");
  const textRef = useRef(text);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const draftTimer = useRef<number | undefined>(undefined);
  const history = useRef<string[]>(getPersisted().history ?? []);
  const historyIdx = useRef<number | null>(null);
  const historyStash = useRef("");
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionTimer = useRef<number | undefined>(undefined);
  const mentionSeq = useRef(0);
  const fileResults = useSelector((s) => s.fileResults);

  const draftDirty = useRef(false);

  /** Write the draft to webview state and the host (debounced; flushed on send/hide/unmount). */
  const flushDraft = () => {
    if (draftTimer.current) {
      window.clearTimeout(draftTimer.current);
      draftTimer.current = undefined;
    }
    if (!draftDirty.current) return;
    draftDirty.current = false;
    persist({ draft: textRef.current });
    post({ type: "draft", text: textRef.current });
  };
  const setText = (next: string) => {
    textRef.current = next;
    setTextState(next);
    draftDirty.current = true;
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(flushDraft, DRAFT_DEBOUNCE);
  };
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flushDraft();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the host's draft once if we have nothing local.
  useEffect(() => {
    if (hostDraft && !textRef.current) setText(hostDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostDraft]);

  // Auto-grow fallback: one write, one read (forced layout), one write.
  const lineHeightRef = useRef(0);
  useLayoutEffect(() => {
    if (CSS_FIELD_SIZING) return;
    const ta = taRef.current;
    if (!ta) return;
    if (!lineHeightRef.current) lineHeightRef.current = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    const max = lineHeightRef.current * MAX_ROWS + 12;
    ta.style.height = "auto";
    const h = ta.scrollHeight;
    ta.style.height = `${Math.min(h, max)}px`;
    ta.style.overflowY = h > max ? "auto" : "hidden";
  }, [text]);

  // Host-driven insert / focus.
  useEffect(
    () =>
      onComposerEvent((e) => {
        const ta = taRef.current;
        if (e.type === "focus") {
          ta?.focus();
          return;
        }
        const cur = textRef.current;
        const start = ta?.selectionStart ?? cur.length;
        const end = ta?.selectionEnd ?? cur.length;
        const before = cur.slice(0, start);
        const after = cur.slice(end);
        const sep = before && !/\s$/.test(before) ? " " : "";
        const next = `${before}${sep}${e.text}${after}`;
        setText(next);
        requestAnimationFrame(() => {
          if (!ta) return;
          const pos = before.length + sep.length + e.text.length;
          ta.focus();
          ta.setSelectionRange(pos, pos);
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const c = session.connection;
  const running = c === "running" || c === "cancelling";
  const canSend = c === "ready" || c === "idle";
  const sendKeyLabel = settings.sendWithCtrlEnter ? "Ctrl/Cmd+Enter" : "Enter";
  const placeholder =
    c === "starting"
      ? "Connecting…"
      : c === "loading"
        ? "Loading history…"
        : c === "disconnected" || c === "error"
          ? "Agent disconnected — reconnect to continue"
          : running
            ? `Working… ${sendKeyLabel} queues for after this turn`
            : "Ask Cursor… (/ for commands)";

  // Slash command popup.
  const slashQuery = text.startsWith("/") && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const commands = session.availableCommands;
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((cmd) => cmd.name.toLowerCase().startsWith(slashQuery) || cmd.name.toLowerCase().includes(slashQuery))),
    [slashQuery, commands],
  );
  const slashOpen = slashQuery !== null && !slashDismissed && slashMatches.length > 0;
  useEffect(() => {
    setSlashIdx(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  /** Recompute the @-mention token from the textarea caret. */
  const refreshMention = (ta: HTMLTextAreaElement | null) => {
    if (!ta) return;
    const next = mentionAt(ta.value, ta.selectionStart ?? ta.value.length);
    setMention((prev) => (prev?.start === next?.start && prev?.query === next?.query ? prev : next));
  };

  // Debounced file search whenever the mention token changes.
  useEffect(() => {
    setMentionIdx(0);
    setMentionDismissed(false);
    window.clearTimeout(mentionTimer.current);
    if (!mention) return;
    mentionTimer.current = window.setTimeout(() => {
      const requestId = ++mentionSeq.current;
      post({ type: "files.search", query: mention.query, requestId });
    }, MENTION_DEBOUNCE);
    return () => window.clearTimeout(mentionTimer.current);
  }, [mention?.start, mention?.query]);

  const mentionFiles = mention && fileResults && fileResults.requestId === mentionSeq.current ? fileResults.files : [];
  const mentionOpen = !!mention && !slashOpen && !mentionDismissed && mentionFiles.length > 0;

  const completeMention = (file: { path: string; name: string }) => {
    if (!mention) return;
    const ta = taRef.current;
    const cur = textRef.current;
    const caret = ta?.selectionStart ?? cur.length;
    const insert = `@${file.path} `;
    const next = cur.slice(0, mention.start) + insert + cur.slice(caret);
    setText(next);
    addAttachment({ kind: "file", label: file.name, path: file.path });
    setMention(null);
    requestAnimationFrame(() => {
      if (!ta) return;
      const pos = mention.start + insert.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const completeSlash = (name: string) => {
    setText(`/${name} `);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const send = (mode: "queue" | "interrupt" = "queue") => {
    const value = textRef.current.trim();
    if (!(canSend || running) || (!value && attachments.length === 0)) return;
    post({ type: "prompt", text: value, attachments, mode });
    if (value) {
      const h = [...history.current.filter((x) => x !== value), value].slice(-HISTORY_LIMIT);
      history.current = h;
      persist({ history: h });
    }
    historyIdx.current = null;
    setText("");
    flushDraft();
    setMention(null);
    clearAttachments();
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ta = e.currentTarget as HTMLTextAreaElement;

    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionFiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionFiles.length) % mentionFiles.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const pick = mentionFiles[mentionIdx] ?? mentionFiles[0];
        if (pick) completeMention(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }

    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const pick = slashMatches[slashIdx] ?? slashMatches[0];
        if (pick) completeSlash(pick.name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }

    if (e.key === "Escape") {
      if (running) {
        e.preventDefault();
        post({ type: "cancel" });
      }
      return;
    }

    if (e.key === "Enter") {
      const mod = e.metaKey || e.ctrlKey;
      // Ctrl/Cmd+Shift+Enter always means "interrupt the running turn and send now".
      if (mod && e.shiftKey) {
        e.preventDefault();
        send("interrupt");
        return;
      }
      const shouldSend = settings.sendWithCtrlEnter ? mod : !e.shiftKey && !mod && !e.altKey;
      if (shouldSend) {
        e.preventDefault();
        send("queue");
      }
      return;
    }

    // Prompt history on an empty textarea (or while browsing).
    if (e.key === "ArrowUp" && (ta.value === "" || historyIdx.current !== null) && ta.selectionStart === 0) {
      const h = history.current;
      if (h.length === 0) return;
      e.preventDefault();
      if (historyIdx.current === null) {
        historyStash.current = ta.value;
        historyIdx.current = h.length - 1;
      } else if (historyIdx.current > 0) {
        historyIdx.current--;
      }
      const v = h[historyIdx.current] ?? "";
      setText(v);
      requestAnimationFrame(() => ta.setSelectionRange(0, 0));
      return;
    }
    if (e.key === "ArrowDown" && historyIdx.current !== null) {
      const h = history.current;
      e.preventDefault();
      if (historyIdx.current < h.length - 1) {
        historyIdx.current++;
        setText(h[historyIdx.current] ?? "");
      } else {
        historyIdx.current = null;
        setText(historyStash.current);
      }
      return;
    }
    if (historyIdx.current !== null && e.key.length === 1) historyIdx.current = null;
  };

  const onPaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      const a = await readImageFile(f);
      if (a) addAttachment(a);
    }
  };

  const slashRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    slashRef.current?.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
  }, [slashIdx, slashOpen]);
  const mentionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mentionRef.current?.querySelector<HTMLElement>(".selected")?.scrollIntoView({ block: "nearest" });
  }, [mentionIdx, mentionOpen]);

  const empty = !text.trim() && attachments.length === 0;
  const sendDisabled = !canSend || empty;

  return (
    <div class="composer">
      <QueuedBar />
      {slashOpen && (
        <div ref={slashRef} class="slash-popup" role="listbox" aria-label="Slash commands" id="slash-listbox">
          {slashMatches.map((cmd, i) => (
            <button title={cmd.description ? `/${cmd.name}: ${cmd.description}` : `Insert /${cmd.name}`}
              key={cmd.name}
              type="button"
              role="option"
              id={`slash-${cmd.name}`}
              aria-selected={i === slashIdx}
              class={`slash-item${i === slashIdx ? " selected" : ""}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => completeSlash(cmd.name)}
            >
              <span class="slash-name">/{cmd.name}</span>
              <span class="slash-desc">{cmd.description}</span>
              {cmd.hint && <span class="slash-hint">{cmd.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div ref={mentionRef} class="slash-popup mention-popup" role="listbox" aria-label="Files" id="mention-listbox">
          {mentionFiles.map((f, i) => (
            <button
              key={f.path}
              type="button"
              role="option"
              id={`mention-${i}`}
              aria-selected={i === mentionIdx}
              class={`slash-item mention-item${i === mentionIdx ? " selected" : ""}`}
              tabIndex={-1}
              title={f.path}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => completeMention(f)}
            >
              <Icon name="file" />
              <span class="mention-name">{f.name}</span>
              <span class="mention-path">{f.path}</span>
            </button>
          ))}
        </div>
      )}
      <div class={`composer-box${running ? " running" : ""}`}>
        <AttachmentChips />
        <textarea
          ref={taRef}
          class="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label="Message"
          aria-autocomplete="list"
          aria-controls={slashOpen ? "slash-listbox" : mentionOpen ? "mention-listbox" : undefined}
          aria-activedescendant={slashOpen ? `slash-${slashMatches[slashIdx]?.name ?? ""}` : mentionOpen ? `mention-${mentionIdx}` : undefined}
          spellcheck
          onInput={(e) => {
            const ta = e.currentTarget as HTMLTextAreaElement;
            setText(ta.value);
            refreshMention(ta);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") refreshMention(e.currentTarget as HTMLTextAreaElement);
          }}
          onClick={(e) => refreshMention(e.currentTarget as HTMLTextAreaElement)}
          onPaste={onPaste}
        />
        <div class="composer-toolbar">
          <div class="composer-toolbar-left">
            <AddMenu />
            <ModePicker />
            <ModelPicker />
            <ReasoningPicker />
            <ApprovalsPicker />
          </div>
          <div class="composer-toolbar-right">
            {running ? (
              <>
                <button type="button" class="send-button queue" title={`Queue for after this turn (${sendKeyLabel}) · Interrupt and send now (Ctrl/Cmd+Shift+Enter)`} aria-label="Queue message" disabled={empty} onClick={() => send("queue")}>
                  <Icon name="list-ordered" />
                </button>
                <button type="button" class="send-button stop" title={c === "cancelling" ? "Cancelling…" : "Stop (Esc)"} aria-label="Stop" disabled={c === "cancelling"} onClick={() => post({ type: "cancel" })}>
                  {c === "cancelling" ? <Spinner /> : <Icon name="debug-stop" />}
                </button>
              </>
            ) : (
              <button type="button" class="send-button" title={`Send (${sendKeyLabel})`} aria-label="Send" disabled={sendDisabled} onClick={() => send("queue")}>
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
