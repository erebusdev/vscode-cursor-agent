import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConfigOption, PromptAttachmentInput } from "../../shared/protocol";
import { clearAttachments, addAttachment, onComposerEvent, removeAttachment, useSelector } from "../store";
import { getPersisted, persist, post } from "../vscode";
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
          <button type="button" class="chip-remove" aria-label={`Remove ${a.label}`} onClick={() => removeAttachment(i)}>
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

function ModelPicker() {
  const models = useSelector((s) => s.session.models);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  if (!models || models.availableModels.length === 0) return null;
  const current = models.availableModels.find((m) => m.modelId === models.currentModelId);
  const q = filter.trim().toLowerCase();
  const filtered = q ? models.availableModels.filter((m) => m.name.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q) || m.description?.toLowerCase().includes(q)) : models.availableModels;
  return (
    <>
      <button ref={anchor} type="button" class="picker" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title="Model">
        <span class="picker-label">{current?.name ?? models.currentModelId}</span>
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
      </Popover>
    </>
  );
}

function optionValueLabel(o: ConfigOption): string {
  if (o.type === "boolean" || typeof o.currentValue === "boolean") return o.currentValue ? "On" : "Off";
  const match = o.options.find((x) => x.value === o.currentValue);
  return match?.name ?? String(o.currentValue);
}

/** "Fast: Fast" reads badly; when the selected value's name repeats the option name, show it alone. */
function optionPillLabel(o: ConfigOption): { name: string; value: string } | { name: string } {
  const value = optionValueLabel(o);
  return value.trim().toLowerCase() === o.name.trim().toLowerCase() ? { name: o.name } : { name: o.name, value };
}

function OptionPill({ option }: { option: ConfigOption }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const isBool = option.type === "boolean" || typeof option.currentValue === "boolean";
  const isSelect = !isBool && option.options.length > 0;
  const choices = isBool
    ? [
        { id: "true", label: "On", selected: option.currentValue === true },
        { id: "false", label: "Off", selected: option.currentValue === false },
      ]
    : option.options.map((x) => ({ id: x.value, label: x.name, description: x.description, selected: x.value === option.currentValue }));

  const select = (id: string) => {
    setOpen(false);
    const value: string | boolean = isBool ? id === "true" : id;
    if (value !== option.currentValue) post({ type: "config.set", configId: option.id, value });
  };

  return (
    <>
      <button ref={anchor} type="button" class="picker pill" aria-haspopup={isSelect || isBool ? "listbox" : "dialog"} aria-expanded={open} onClick={() => setOpen(!open)} title={option.description ?? option.name}>
        {"value" in optionPillLabel(option) ? (
          <>
            <span class="pill-name">{option.name}:</span> <span class="picker-label">{optionValueLabel(option)}</span>
          </>
        ) : (
          <span class="picker-label">{option.name}</span>
        )}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={option.name} role={isSelect || isBool ? "listbox" : "dialog"} minWidth={180}>
        {isSelect || isBool ? (
          <PopoverList options={choices} onSelect={select} />
        ) : (
          <form
            class="popover-form"
            onSubmit={(e) => {
              e.preventDefault();
              setOpen(false);
              post({ type: "config.set", configId: option.id, value: text });
            }}
          >
            <input type="text" class="text-input" data-autofocus aria-label={option.name} placeholder={String(option.currentValue)} value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
            <button type="submit" class="button primary small">
              Set
            </button>
          </form>
        )}
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function readImageFile(file: File): Promise<PromptAttachmentInput | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      if (comma < 0) return resolve(null);
      resolve({
        kind: "image",
        label: file.name || `image.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`,
        data: url.slice(comma + 1),
        mimeType: file.type || "image/png",
      });
    };
    reader.readAsDataURL(file);
  });
}

/** The message waiting to go out after the current turn, with edit / send-now / remove. */
function QueuedBar() {
  const queued = useSelector((s) => s.session.queued);
  const running = useSelector((s) => s.session.connection === "running" || s.session.connection === "cancelling");
  if (!queued) return null;
  const preview = queued.text.trim().replace(/\s+/g, " ") || `${queued.attachmentCount} attachment${queued.attachmentCount === 1 ? "" : "s"}`;
  return (
    <div class="queued-bar" role="status" aria-label="Queued message">
      <Icon name="list-ordered" />
      <span class="queued-label">{running ? "Queued" : "Queued (stopped)"}</span>
      <span class="queued-text" title={queued.text}>
        {preview}
        {queued.attachmentCount > 0 && queued.text.trim() ? ` · ${queued.attachmentCount} attachment${queued.attachmentCount === 1 ? "" : "s"}` : ""}
      </span>
      <span class="queued-actions">
        <button type="button" class="link-button" title="Interrupt the current turn and send this now" onClick={() => post({ type: "queue.sendNow" })}>
          Send now
        </button>
        <button type="button" class="link-button" title="Put it back in the composer" onClick={() => post({ type: "queue.edit" })}>
          Edit
        </button>
        <IconButton icon="close" label="Remove queued message" onClick={() => post({ type: "queue.clear" })} />
      </span>
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
            <button
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
            {session.modelOptions.map((o) => (
              <OptionPill key={o.id} option={o} />
            ))}
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
