import { useEffect } from "preact/hooks";
import type { SessionModel } from "../../../shared/protocol";
import {
  isAutoModel,
  modelGroup,
  sortModelsByFamily,
  type ModelGroup,
} from "../../../shared/modelVisibility";
import { getState, useSelector } from "../../store";
import { post } from "../../vscode";
import { Icon } from "../ui";
import { Checkbox, SettingRow, SettingsGroup, Toggle } from "./controls";

/** Auto is not listed here; it has its own switch (see AutoRow). */
const GROUPS: ReadonlyArray<{
  id: Exclude<ModelGroup, "auto">;
  title: string;
  blurb: string;
}> = [
  {
    id: "cursor",
    title: "Cursor models",
    blurb: "Cursor's own models, billed as Cursor usage.",
  },
  {
    id: "api",
    title: "API models",
    blurb: "Third-party models, billed as API usage.",
  },
];

function setHidden(hiddenModels: ReadonlyArray<string>): void {
  post({ type: "settings.update", key: "hiddenModels", value: hiddenModels });
}

function ModelRow({
  model,
  current,
  hidden,
}: {
  model: SessionModel;
  current: boolean;
  hidden: boolean;
}) {
  return (
    <div class={`models-row${hidden ? " dim" : ""}`}>
      <Checkbox
        id={`model-${model.modelId}`}
        checked={!hidden}
        label={`Show ${model.name}`}
        onChange={(show) => {
          const list = getState().settings.hiddenModels;
          setHidden(
            show
              ? list.filter((id) => id !== model.modelId)
              : [...list, model.modelId],
          );
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
function GroupCheckbox({
  id,
  label,
  members,
  hidden,
}: {
  id: string;
  label: string;
  members: ReadonlyArray<SessionModel>;
  hidden: ReadonlyArray<string>;
}) {
  const shownCount = members.filter((m) => !hidden.includes(m.modelId)).length;
  const all = shownCount === members.length;
  const none = shownCount === 0;
  const title = all
    ? `Hide all ${label.toLowerCase()}`
    : `Show all ${label.toLowerCase()}`;
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
        setHidden(
          all || !none
            ? [...new Set([...list, ...ids])]
            : list.filter((x) => !ids.includes(x)),
        );
      }}
    >
      {all ? <Icon name="check" /> : none ? null : <Icon name="dash" />}
    </button>
  );
}

/** Auto on its own: whether the model picker offers the Auto switch. */
export function AutoRow() {
  const models = useSelector((s) => s.session.models);
  const hidden = useSelector((s) => s.settings.hiddenModels);
  const auto = models?.availableModels.find((m) =>
    isAutoModel(m.modelId, m.name),
  );
  if (!auto) return null;
  const offered = !hidden.includes(auto.modelId);
  return (
    <SettingsGroup title="Auto">
      <SettingRow
        id="models-auto"
        label="Show Auto in the model picker"
        description="Cursor picks the model for each request."
        control={
          <Toggle
            id="models-auto"
            checked={offered}
            onChange={(show) => {
              const list = getState().settings.hiddenModels;
              setHidden(
                show
                  ? list.filter((id) => id !== auto.modelId)
                  : [...list, auto.modelId],
              );
            }}
          />
        }
      />
    </SettingsGroup>
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

  const all = (models?.availableModels ?? []).filter(
    (m) => !isAutoModel(m.modelId, m.name),
  );
  const hidden = settings.hiddenModels;
  const hiddenCount = all.filter((m) => hidden.includes(m.modelId)).length;

  return (
    <SettingRow
      id="models-show-all"
      labelFor={false}
      label="Shown in the model picker"
      description={
        <>
          Untick a model to hide it.
          {usageLoading ? " Checking which models are Cursor's…" : ""}
        </>
      }
      settingKey="hiddenModels"
      control={
        hiddenCount > 0 ? (
          <button
            id="models-show-all"
            type="button"
            class="button secondary small"
            title="Show every model again"
            onClick={() => setHidden([])}
          >
            Show all ({hiddenCount} hidden)
          </button>
        ) : undefined
      }
    >
      {all.length === 0 && (
        <div class="list-empty">
          No models yet.{" "}
          <button
            type="button"
            class="link-button"
            title="Start the agent"
            onClick={() => post({ type: "session.reconnect" })}
          >
            Connect
          </button>
        </div>
      )}
      <div class="models-grid">
        {GROUPS.map((g) => {
          const members = all.filter(
            (m) => modelGroup(m.modelId, cursorIds, m.name) === g.id,
          );
          if (members.length === 0) return null;
          return (
            <section
              key={g.id}
              class="models-group"
              aria-labelledby={`models-${g.id}`}
            >
              <div class="models-group-head">
                {/* Same slot in every group, so the headings line up; with one model it ticks that model. */}
                <GroupCheckbox
                  id={`models-group-${g.id}`}
                  label={g.title}
                  members={members}
                  hidden={hidden}
                />
                <h4 id={`models-${g.id}`} class="pane-heading">
                  {g.title}
                </h4>
                <span class="models-group-count">
                  {members.filter((m) => !hidden.includes(m.modelId)).length}/
                  {members.length}
                </span>
              </div>
              <p class="pane-note">{g.blurb}</p>
              {/* No lab headings: ids do not say who makes a model. Families stay together, newest first. */}
              {sortModelsByFamily(members).map((x) => (
                <ModelRow
                  key={x.modelId}
                  model={x}
                  current={x.modelId === models?.currentModelId}
                  hidden={hidden.includes(x.modelId)}
                />
              ))}
            </section>
          );
        })}
      </div>
    </SettingRow>
  );
}
