import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import type { SessionModel } from "../../../shared/protocol";
import { modelFamily, modelGroup, sortModelsByFamily, type ModelGroup } from "../../../shared/modelVisibility";
import { getState, useSelector } from "../../store";
import { post } from "../../vscode";
import { Icon } from "../ui";
import { Checkbox, SettingRow } from "./controls";

const GROUPS: ReadonlyArray<{ id: ModelGroup; title: string; blurb: string }> = [
  { id: "auto", title: "Auto", blurb: "Cursor picks the model per request, including third-party ones, and bills it as that model." },
  { id: "cursor", title: "Cursor models", blurb: "Cursor's own models, including Grok and Composer. Count as Cursor usage." },
  { id: "api", title: "API models", blurb: "Third-party models. Count as API usage." },
];

function setHidden(hiddenModels: ReadonlyArray<string>): void {
  post({ type: "settings.update", key: "hiddenModels", value: hiddenModels });
}

function ModelRow({ model, current, hidden }: { model: SessionModel; current: boolean; hidden: boolean }) {
  return (
    <div class={`models-row${hidden ? " dim" : ""}`}>
      <Checkbox
        id={`model-${model.modelId}`}
        checked={!hidden}
        label={`Show ${model.name}`}
        onChange={(show) => {
          const list = getState().settings.hiddenModels;
          setHidden(show ? list.filter((id) => id !== model.modelId) : [...list, model.modelId]);
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

/** Group checkbox: ticks or unticks every model in the group; shows a partial state when mixed. */
function GroupCheckbox({ id, label, members, hidden }: { id: string; label: string; members: ReadonlyArray<SessionModel>; hidden: ReadonlyArray<string> }) {
  const shownCount = members.filter((m) => !hidden.includes(m.modelId)).length;
  const all = shownCount === members.length;
  const none = shownCount === 0;
  const title = all ? `Hide all ${label.toLowerCase()}` : `Show all ${label.toLowerCase()}`;
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={all ? true : none ? false : "mixed"}
      aria-label={title}
      title={title}
      class={`checkbox${all ? " checked" : none ? "" : " mixed"}`}
      onClick={() => {
        const ids = members.map((m) => m.modelId);
        const list = getState().settings.hiddenModels;
        // Mixed or all shown → hide the lot; none shown → show the lot.
        setHidden(all || !none ? [...new Set([...list, ...ids])] : list.filter((x) => !ids.includes(x)));
      }}
    >
      {all ? <Icon name="check" /> : none ? null : <Icon name="dash" />}
    </button>
  );
}

/** Model visibility manager, shown in the settings tab's Models section. */
export function ManageModels() {
  const models = useSelector((s) => s.session.models);
  const settings = useSelector((s) => s.settings);
  const cursorIds = useSelector((s) => s.usage.summary?.autoModels);
  const usageLoading = useSelector((s) => s.usage.loading);

  useEffect(() => {
    // The usage API knows which ids Cursor bills as its own; fetch it once so grouping is accurate.
    const u = getState().usage;
    if (!u.loading && !u.summary?.autoModels) post({ type: "usage.refresh" });
  }, []);

  const all = models?.availableModels ?? [];
  const hidden = settings.hiddenModels;
  const hiddenCount = all.filter((m) => hidden.includes(m.modelId)).length;

  return (
    <SettingRow
      id="models-show-all"
      labelFor={false}
      label="Shown in the model picker"
      description={
        <>
          Untick a model to hide it from the picker. A group's box ticks or unticks all of its models. New models Cursor adds stay visible until you hide them.
          {usageLoading ? " Checking which models are Cursor's…" : ""}
        </>
      }
      settingKey="hiddenModels"
      control={
        hiddenCount > 0 ? (
          <button id="models-show-all" type="button" class="button secondary small" title="Show every model again" onClick={() => setHidden([])}>
            Show all ({hiddenCount} hidden)
          </button>
        ) : undefined
      }
    >
      {all.length === 0 && (
        <div class="list-empty">
          No models reported yet. Connect to the agent first.{" "}
          <button type="button" class="link-button" title="Start the agent" onClick={() => post({ type: "session.reconnect" })}>
            Connect
          </button>
        </div>
      )}
      <div class="models-grid">
      {GROUPS.map((g) => {
        const members = all.filter((m) => modelGroup(m.modelId, cursorIds) === g.id);
        if (members.length === 0) return null;
        return (
          <section key={g.id} class="models-group" aria-labelledby={`models-${g.id}`}>
            <div class="models-group-head">
              {/* Same slot in every group, so the headings line up; with one model it ticks that model. */}
              <GroupCheckbox id={`models-group-${g.id}`} label={g.title} members={members} hidden={hidden} />
              <h4 id={`models-${g.id}`} class="pane-heading">
                {g.title}
              </h4>
              <span class="models-group-count">{members.filter((m) => !hidden.includes(m.modelId)).length}/{members.length}</span>
            </div>
            <p class="pane-note">{g.blurb}</p>
            {(() => {
              // Flat, fully keyed list: a family label (when the family has several models) followed by its rows.
              const sorted = sortModelsByFamily(members);
              const counts = new Map<string, number>();
              for (const x of sorted) counts.set(modelFamily(x.modelId), (counts.get(modelFamily(x.modelId)) ?? 0) + 1);
              const items: JSX.Element[] = [];
              let lastFamily = "";
              for (const x of sorted) {
                const family = modelFamily(x.modelId);
                if (family !== lastFamily && (counts.get(family) ?? 0) > 1) {
                  items.push(
                    <div key={`fam-${family}`} class="models-family">
                      {family.replace(/-/g, " ")}
                    </div>,
                  );
                }
                lastFamily = family;
                items.push(<ModelRow key={x.modelId} model={x} current={x.modelId === models?.currentModelId} hidden={hidden.includes(x.modelId)} />);
              }
              return items;
            })()}
          </section>
        );
      })}
      </div>
    </SettingRow>
  );
}
