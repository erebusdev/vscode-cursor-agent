/**
 * Which models the picker shows. Hiding is an explicit list of ids, so a model
 * Cursor adds later is visible until someone hides it. Groups only organise the
 * manager pane; ticking a group is a bulk action over its models.
 */

/**
 * Auto is not a model: Cursor routes each request to a model (its own or a
 * third-party one, depending on the account's Auto settings) and bills it as
 * that model. It is kept out of the model groups and shown as a switch.
 */
export type ModelGroup = "auto" | "cursor" | "api";

/** True for Cursor's Auto entry. The CLI reports it as id `default` named "Auto"; older builds used `auto…` ids. */
export function isAutoModel(modelId: string, name?: string): boolean {
  const base = modelId.replace(/\[.*$/, "").trim().toLowerCase();
  return base === "default" || /^auto\b/.test(base) || name?.trim().toLowerCase() === "auto";
}

/** Cursor's own model families: Composer, Vega, Grok, and anything Cursor-prefixed. */
const CURSOR_MODEL_ID = /^(composer|vega|grok|cursor)/i;

export interface ModelVisibility {
  readonly hiddenModels: ReadonlyArray<string>;
}

/** Group for a model id, preferring the usage API's list of Cursor-pool ids when available. */
export function modelGroup(modelId: string, cursorModelIds?: ReadonlyArray<string>, name?: string): ModelGroup {
  const base = modelId.replace(/\[.*$/, "");
  if (isAutoModel(modelId, name)) return "auto";
  if (CURSOR_MODEL_ID.test(base)) return "cursor";
  // The usage API's list catches ids the prefix rule does not know about (it lags new releases, so it only ever adds).
  if (cursorModelIds?.some((id) => id === base || base.startsWith(`${id}-`) || id.startsWith(`${base}-`))) return "cursor";
  return "api";
}

export function isModelHidden(modelId: string, visibility: Partial<ModelVisibility>): boolean {
  return (visibility.hiddenModels ?? []).includes(modelId);
}

/** Models to offer in the picker: everything not hidden, plus the current one even if hidden. */
export function visibleModels<T extends { modelId: string }>(models: ReadonlyArray<T>, currentModelId: string | undefined, visibility: Partial<ModelVisibility>): T[] {
  return models.filter((m) => m.modelId === currentModelId || !isModelHidden(m.modelId, visibility));
}

/** Family of a model id: the leading name before any version, e.g. "claude-opus", "gpt", "grok", "composer". */
export function modelFamily(modelId: string): string {
  const base = modelId.replace(/\[.*$/, "").toLowerCase();
  if (isAutoModel(base)) return "auto";
  // Cut at the first token that starts with a digit ("claude-opus-5-5" → "claude-opus", "gpt-5.5" → "gpt", "o3-pro" → "o3-pro").
  const tokens = base.split(/[-_.]/);
  const cut = tokens.findIndex((t, i) => i > 0 && /^\d/.test(t));
  return (cut > 0 ? tokens.slice(0, cut) : tokens).join("-");
}

/** Numeric parts of a model id, for newest-first ordering within a family. */
function versionKey(modelId: string): number[] {
  return (modelId.replace(/\[.*$/, "").match(/\d+/g) ?? []).map(Number);
}

/**
 * Orders models so families stay together (Auto first, then alphabetical) and,
 * within a family, newer versions come first; ties keep Cursor's order.
 */
export function sortModelsByFamily<T extends { modelId: string; name?: string }>(models: ReadonlyArray<T>): T[] {
  return models
    .map((m, i) => ({ m, i, family: modelFamily(m.modelId), v: versionKey(m.modelId) }))
    .sort((a, b) => {
      if (a.family !== b.family) {
        if (a.family === "auto") return -1;
        if (b.family === "auto") return 1;
        return a.family.localeCompare(b.family);
      }
      const n = Math.max(a.v.length, b.v.length);
      for (let k = 0; k < n; k++) {
        const d = (b.v[k] ?? 0) - (a.v[k] ?? 0);
        if (d !== 0) return d;
      }
      return a.i - b.i;
    })
    .map((x) => x.m);
}
