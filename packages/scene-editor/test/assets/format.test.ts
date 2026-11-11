import { describe, expect, it } from "vitest";
import { assetFormatHint } from "../../src/assets/format";
import { detectFormatFromUrl } from "../../src/assets/universal-asset-loader";

describe("assetFormatHint", () => {
  it("reads the extension off a normal path", () => {
    expect(assetFormatHint("/assets/Fox.GLB?v=2")).toBe("glb");
    expect(assetFormatHint("https://cdn.test/a/legacy.obj")).toBe("obj");
  });

  it("falls back to the asset id when the URL has none", () => {
    // What `loadFiles()` produces: a Blob URL plus an id that keeps the suffix.
    expect(assetFormatHint("blob:http://127.0.0.1:4173/0bf97fae-0000", "upload-1-fox.glb")).toBe(
      "glb",
    );
    expect(assetFormatHint("/api/models/42", "/x/truck.obj")).toBe("obj");
  });

  it("does not treat a dotted path segment as an extension", () => {
    // Regression: the old `split(".").pop()` produced "1:4173/uuid" here and the
    // load failed with `asset-unsupported-format` on a perfectly good upload.
    expect(assetFormatHint("blob:http://127.0.0.1:4173/0bf97fae-0000")).toBeNull();
    expect(assetFormatHint("data:model/gltf-binary;base64,AAAA")).toBeNull();
  });

  it("has no opinion when neither side carries one", () => {
    expect(assetFormatHint("/api/model")).toBeNull();
  });
});

describe("detectFormatFromUrl", () => {
  it("uses the hint, then falls back to glb", () => {
    expect(detectFormatFromUrl("blob:http://host/uuid", "upload-1-fox.glb")).toBe("glb");
    expect(detectFormatFromUrl("blob:http://host/uuid", "upload-1-truck.obj")).toBe("obj");
    expect(detectFormatFromUrl("/api/model")).toBe("glb");
  });

  it("keeps the data-URI shortcut", () => {
    expect(detectFormatFromUrl("data:model/gltf+json;base64,AAAA")).toBe("glb");
  });
});
