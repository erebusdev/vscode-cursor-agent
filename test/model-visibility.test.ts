import { describe, expect, it } from "vitest";
import { isModelHidden, modelGroup, visibleModels } from "../src/shared/modelVisibility";

const models = [{ modelId: "auto-smart" }, { modelId: "composer-2" }, { modelId: "grok-4.7" }, { modelId: "claude-opus-5-5" }, { modelId: "gpt-5.5" }];
const cursorIds = ["default", "composer-2", "composer-2-fast", "grok-4.5", "grok-4.5-high"];

describe("model visibility", () => {
  it("groups by the usage API's Cursor list when available, else by id prefix", () => {
    expect(modelGroup("composer-2", cursorIds)).toBe("cursor");
    expect(modelGroup("grok-4.5-high", cursorIds)).toBe("cursor");
    expect(modelGroup("claude-opus-5-5", cursorIds)).toBe("api");
    expect(modelGroup("auto-smart", cursorIds)).toBe("cursor");
    expect(modelGroup("grok-4.7[context=256k]")).toBe("cursor");
    expect(modelGroup("grok-4.7", cursorIds)).toBe("cursor");
    expect(modelGroup("vega-high")).toBe("cursor");
  });

  it("hides by id and by group, but never the current model", () => {
    const vis = { hiddenModels: ["gpt-5.5"], hiddenModelGroups: ["api" as const] };
    expect(isModelHidden("gpt-5.5", vis)).toBe(true);
    expect(isModelHidden("claude-opus-5-5", vis)).toBe(true);
    expect(isModelHidden("composer-2", vis)).toBe(false);
    expect(visibleModels(models, "claude-opus-5-5", vis).map((m) => m.modelId)).toEqual(["auto-smart", "composer-2", "grok-4.7", "claude-opus-5-5"]);
  });

  it("shows everything when nothing is hidden, so new models appear by default", () => {
    expect(visibleModels(models, undefined, { hiddenModels: [], hiddenModelGroups: [] })).toHaveLength(models.length);
  });
});
