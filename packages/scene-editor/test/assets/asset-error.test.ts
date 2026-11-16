import { describe, expect, it } from "vitest";
import { describeAsset } from "../../src/assets/asset-error";

/**
 * The label a failed load paints in the element's error slot. It has exactly one
 * job: tell the reader which thing to go look at.
 */
describe("describeAsset", () => {
  it("prefers the URL that was tried", () => {
    expect(describeAsset("__src__", "https://cdn.example.com/robot.glb")).toBe(
      "https://cdn.example.com/robot.glb",
    );
    expect(describeAsset("robot", "/assets/robot.glb")).toBe("/assets/robot.glb");
  });

  it("falls back to the id when the URL says nothing", () => {
    // `loadFiles()` resolves to an opaque Blob URL; the id carries the filename.
    expect(describeAsset("upload-fox.glb", "blob:http://127.0.0.1:3000/9f2c-1a")).toBe(
      "upload-fox.glb",
    );
    expect(describeAsset("inline.glb", "data:model/gltf-binary;base64,AAAA")).toBe(
      "inline.glb",
    );
    expect(describeAsset("gone")).toBe("gone");
  });

  it("does not repeat an id that is its own URL", () => {
    expect(describeAsset("robot.glb", "robot.glb")).toBe("robot.glb");
  });
});
