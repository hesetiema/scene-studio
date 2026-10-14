import { describe, expect, it } from "vitest";
import { SCENE_EDITOR_VERSION } from "../src/index";

describe("scaffold smoke", () => {
  it("exports a semver-ish version", () => {
    expect(SCENE_EDITOR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
