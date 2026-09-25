import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  isSettingsSection,
  joinArgs,
  mcpNeedsApproval,
  parseArgs,
  parseSettingsSection,
  safeListFromRows,
  safeListToRows,
  safePatternError,
  splitPastedPatterns,
} from "../src/shared/settingsUi";

describe("settings section ids", () => {
  it("lists the nav sections in order", () => {
    expect(SETTINGS_SECTIONS).toEqual(["general", "agent", "approvals", "models", "mcp", "advanced"]);
    expect(DEFAULT_SETTINGS_SECTION).toBe("general");
  });

  it("accepts only known ids", () => {
    expect(isSettingsSection("models")).toBe(true);
    expect(isSettingsSection("Models")).toBe(false);
    expect(isSettingsSection("nope")).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
    expect(isSettingsSection(3)).toBe(false);
  });

  it("normalises command arguments, including the old tab names and { section } objects", () => {
    expect(parseSettingsSection("mcp")).toBe("mcp");
    expect(parseSettingsSection("  Approvals ")).toBe("approvals");
    expect(parseSettingsSection("behaviour")).toBe("general");
    expect(parseSettingsSection("mcp-servers")).toBe("mcp");
    expect(parseSettingsSection({ section: "agent" })).toBe("agent");
    expect(parseSettingsSection({ section: "bogus" })).toBeUndefined();
    expect(parseSettingsSection("bogus")).toBeUndefined();
    expect(parseSettingsSection(undefined)).toBeUndefined();
    expect(parseSettingsSection(null)).toBeUndefined();
    // A VS Code URI or other object passed by a menu is not a section.
    expect(parseSettingsSection({ scheme: "file", path: "/x" })).toBeUndefined();
  });
});

describe("agent arguments", () => {
  it("round-trips quoted arguments", () => {
    const args = ["-e", "https://api2.cursor.sh", "--name", "two words"];
    expect(parseArgs(joinArgs(args))).toEqual(args);
    expect(parseArgs(`-e 'single quoted' "double quoted"`)).toEqual(["-e", "single quoted", "double quoted"]);
    expect(joinArgs(["a", "b c"])).toBe('a "b c"');
    expect(parseArgs("   ")).toEqual([]);
  });
});

describe("safe list rows", () => {
  it("serialises rows: trims, drops empties and duplicates, keeps order", () => {
    expect(safeListFromRows(["  ^ls\\b ", "", "^git status\\b", "^ls\\b", "   "])).toEqual(["^ls\\b", "^git status\\b"]);
    expect(safeListFromRows([])).toEqual([]);
  });

  it("parses the stored list, ignoring hand-edited non-strings", () => {
    expect(safeListToRows(["^a", 3, null, "^b"])).toEqual(["^a", "^b"]);
    expect(safeListToRows(undefined)).toEqual([]);
  });

  it("flags patterns that do not compile, with a short reason", () => {
    expect(safePatternError("^(cd|ls)\\b")).toBeUndefined();
    expect(safePatternError("")).toBeUndefined();
    const error = safePatternError("(unclosed");
    expect(error).toBeTruthy();
    expect(error).not.toMatch(/^Invalid regular expression/);
  });

  it("splits pasted multi-line text into patterns", () => {
    expect(splitPastedPatterns("^a\r\n\n  ^b  \n")).toEqual(["^a", "^b"]);
  });
});

describe("MCP approval wording", () => {
  it("recognises the CLI's approval states", () => {
    expect(mcpNeedsApproval({ status: "needs approval" })).toBe(true);
    expect(mcpNeedsApproval({ status: "Not approved (run agent mcp enable)" })).toBe(true);
    expect(mcpNeedsApproval({ status: "ready" })).toBe(false);
  });
});
