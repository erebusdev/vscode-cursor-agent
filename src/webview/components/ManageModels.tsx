import { useEffect, useRef } from "preact/hooks";
import type { SessionModel } from "../../shared/protocol";
import { modelGroup, type ModelGroup } from "../../shared/modelVisibility";
import { getState, setModelsOpen, useSelector } from "../store";
import { post } from "../vscode";
import { Checkbox } from "./SettingsView";
import { IconButton } from "./ui";

const GROUPS: ReadonlyArray<{ id: ModelGroup; title: string; blurb: string }> = [
  { id: "cursor", title: "Cursor models", blurb: "Cursor's own models. Count as Cursor usage." },
  { id: "api", title: "API models", blurb: "Third-party models. Count as API usage." },
];

function setHidden(next: { hiddenModels?: ReadonlyArray<string>; hiddenModelGroups?: ReadonlyArray<ModelGroup> }): void {
  if (next.hiddenModels) post({ type: "settings.update", key: "hiddenModels", value: next.hiddenModels });
  if (next.hiddenModelGroups) post({ type: "settings.update", key: "hiddenModelGroups", value: next.hiddenModelGroups });
}

function ModelRow({ model, current, groupHidden, hidden }: { model: SessionModel; current: boolean; groupHidden: boolean; hidden: boolean }) {
  const shown = !hidden && !groupHidden;
  return (
    <div class={`models-row${shown ? "" : " dim"}`}>
      <Checkbox
        id={`model-${model.modelId}`}
        checked={!hidden}
        label={`Show ${model.name}`}
        onChange={(show) => {
          const list = getState().settings.hiddenModels;
          setHidden({ hiddenModels: show ? list.filter((id) => id !== model.modelId) : [...list, model.modelId] });
        }}
      />
      <span class="models-row-name" title={model.description ?? model.modelId}>
        {model.name}
      </span>
      {current && <span class="models-row-current">current</span>}
      <span class="models-row-id">{model.modelId}</span>
    </div>
  );
}

export function ManageModelsView() {
  const models = useSelector((s) => s.session.models);
  const settings = useSelector((s) => s.settings);
  const cursorIds = useSelector((s) => s.usage.summary?.autoModels);
  const usageLoading = useSelector((s) => s.usage.loading);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    // The usage API tells us which ids count as Cursor's pool; fetch it once so grouping is accurate.
    const u = getState().usage;
    if (!u.loading && !u.summary?.autoModels) post({ type: "usage.refresh" });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest(".popover")) return;
      e.preventDefault();
      setModelsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const all = models?.availableModels ?? [];
  const hiddenCount = all.filter((m) => settings.hiddenModels.includes(m.modelId) || settings.hiddenModelGroups.includes(modelGroup(m.modelId, cursorIds))).length;

  return (
    <div class="pane models-view" role="region" aria-label="Manage models">
      <div class="pane-top">
        <IconButton ref={backRef} icon="arrow-left" label="Back to chat" onClick={() => setModelsOpen(false)} />
        <h2 class="pane-title">Models</h2>
        <span class="pane-top-actions">
          {hiddenCount > 0 && (
            <button type="button" class="link-button" onClick={() => setHidden({ hiddenModels: [], hiddenModelGroups: [] })}>
              Show all
            </button>
          )}
        </span>
      </div>
      <div class="pane-scroll">
        <p class="pane-note">Untick a model to hide it from the picker. New models Cursor adds stay visible until you hide them.{usageLoading ? " Checking which models are Cursor's…" : ""}</p>
        {all.length === 0 && <div class="pane-empty">No models reported yet. Connect to the agent first.</div>}
        {GROUPS.map((g) => {
          const members = all.filter((m) => modelGroup(m.modelId, cursorIds) === g.id);
          if (members.length === 0) return null;
          const groupHidden = settings.hiddenModelGroups.includes(g.id);
          return (
            <section key={g.id} class="models-group" aria-labelledby={`models-${g.id}`}>
              <div class="models-group-head">
                <Checkbox
                  id={`models-group-${g.id}`}
                  checked={!groupHidden}
                  label={`Show ${g.title}`}
                  onChange={(show) => {
                    const groups = getState().settings.hiddenModelGroups;
                    setHidden({ hiddenModelGroups: show ? groups.filter((id) => id !== g.id) : [...groups, g.id] });
                  }}
                />
                <h3 id={`models-${g.id}`} class="pane-heading">
                  {g.title}
                </h3>
                <span class="models-group-count">{members.length}</span>
              </div>
              <p class="pane-note">{g.blurb}</p>
              {members.map((m) => (
                <ModelRow key={m.modelId} model={m} current={m.modelId === models?.currentModelId} groupHidden={groupHidden} hidden={settings.hiddenModels.includes(m.modelId)} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
