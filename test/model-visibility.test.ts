import { describe, expect, it } from "vitest";
import { isAutoModel, isModelHidden, modelFamily, modelGroup, sortModelsByFamily, visibleModels } from "../src/shared/modelVisibility";

const models = [{ modelId: "auto-smart" }, { modelId: "composer-2" }, { modelId: "grok-4.7" }, { modelId: "claude-opus-5-5" }, { modelId: "gpt-5.5" }];
const cursorIds = ["default", "composer-2", "composer-2-fast", "grok-4.5", "grok-4.5-high"];

describe("model visibility", () => {
  it("groups by the usage API's Cursor list when available, else by id prefix", () => {
    expect(modelGroup("composer-2", cursorIds)).toBe("cursor");
    expect(modelGroup("grok-4.5-high", cursorIds)).toBe("cursor");
    expect(modelGroup("claude-opus-5-5", cursorIds)).toBe("api");
    expect(modelGroup("auto-smart", cursorIds)).toBe("auto");
    expect(modelGroup("auto")).toBe("auto");
    expect(modelGroup("grok-4.7[context=256k]")).toBe("cursor");
    expect(modelGroup("grok-4.7", cursorIds)).toBe("cursor");
    expect(modelGroup("vega-high")).toBe("cursor");
  });

  it("hides by id, but never the current model", () => {
    const vis = { hiddenModels: ["gpt-5.5", "claude-opus-5-5"] };
    expect(isModelHidden("gpt-5.5", vis)).toBe(true);
    expect(isModelHidden("composer-2", vis)).toBe(false);
    expect(visibleModels(models, "claude-opus-5-5", vis).map((m) => m.modelId)).toEqual(["auto-smart", "composer-2", "grok-4.7", "claude-opus-5-5"]);
  });

  it("shows everything when nothing is hidden, so new models appear by default", () => {
    expect(visibleModels(models, undefined, { hiddenModels: [] })).toHaveLength(models.length);
  });
});

describe("family ordering", () => {
  it("derives families and keeps them together, newest first", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("claude-opus");
    expect(modelFamily("gpt-5.5")).toBe("gpt");
    expect(modelFamily("grok-4.7[context=256k]")).toBe("grok");
    expect(modelFamily("auto-smart")).toBe("auto");
    const ids = ["gpt-5", "claude-sonnet-4-5", "grok-4.5", "claude-sonnet-5", "gpt-5.5", "auto-smart", "grok-4.7"];
    expect(sortModelsByFamily(ids.map((modelId) => ({ modelId }))).map((m) => m.modelId)).toEqual(["auto-smart", "claude-sonnet-5", "claude-sonnet-4-5", "gpt-5.5", "gpt-5", "grok-4.7", "grok-4.5"]);
  });
});

describe("Auto", () => {
  it("recognises the CLI's real Auto entry and keeps it out of the Cursor and API groups", () => {
    expect(isAutoModel("default", "Auto")).toBe(true);
    expect(isAutoModel("default[]")).toBe(true);
    expect(isAutoModel("auto-smart")).toBe(true);
    expect(isAutoModel("some-id", "Auto")).toBe(true);
    expect(isAutoModel("composer-2.5", "Composer 2.5")).toBe(false);
    expect(isAutoModel("claude-opus-5-5", "Claude Opus 5.5")).toBe(false);
    // Even if the usage API lists it among Cursor-billed ids, Auto stays Auto.
    expect(modelGroup("default", ["default", "composer-2.5"], "Auto")).toBe("auto");
    expect(modelGroup("default")).toBe("auto");
  });

  it("keeps single-model families next to their neighbours by name, with no lab grouping", () => {
    const ids = ["gpt-5.5", "kimi-k3", "muse-spark-1.3", "gpt-5.6-sol", "kimi-k2.7-code", "glm-5.2", "gemini-3.1-pro"];
    expect(sortModelsByFamily(ids.map((modelId) => ({ modelId }))).map((m) => m.modelId)).toEqual(["gemini-3.1-pro", "glm-5.2", "gpt-5.6-sol", "gpt-5.5", "kimi-k2.7-code", "kimi-k3", "muse-spark-1.3"]);
  });
});
