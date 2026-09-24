/**
 * Which models the picker shows. Hiding is an explicit list (ids) plus optional
 * whole groups, so a model Cursor adds later is visible until someone hides it.
 */

export type ModelGroup = "cursor" | "api";

/** Cursor's own model families: auto routing, Composer, Vega, Grok, and anything Cursor-prefixed. */
const CURSOR_MODEL_ID = /^(auto\b|composer|vega|grok|cursor)/i;

export interface ModelVisibility {
  readonly hiddenModels: ReadonlyArray<string>;
  readonly hiddenModelGroups: ReadonlyArray<ModelGroup>;
}

/** Group for a model id, preferring the usage API's list of Cursor-pool ids when available. */
export function modelGroup(modelId: string, cursorModelIds?: ReadonlyArray<string>): ModelGroup {
  const base = modelId.replace(/\[.*$/, "");
  if (CURSOR_MODEL_ID.test(base)) return "cursor";
  // The usage API's list catches ids the prefix rule does not know about (it lags new releases, so it only ever adds).
  if (cursorModelIds?.some((id) => id === base || base.startsWith(`${id}-`) || id.startsWith(`${base}-`))) return "cursor";
  return "api";
}

export function isModelHidden(modelId: string, visibility: Partial<ModelVisibility>, cursorModelIds?: ReadonlyArray<string>): boolean {
  if ((visibility.hiddenModels ?? []).includes(modelId)) return true;
  return (visibility.hiddenModelGroups ?? []).includes(modelGroup(modelId, cursorModelIds));
}

/** Models to offer in the picker: everything not hidden, plus the current one even if hidden. */
export function visibleModels<T extends { modelId: string }>(models: ReadonlyArray<T>, currentModelId: string | undefined, visibility: Partial<ModelVisibility>, cursorModelIds?: ReadonlyArray<string>): T[] {
  return models.filter((m) => m.modelId === currentModelId || !isModelHidden(m.modelId, visibility, cursorModelIds));
}
