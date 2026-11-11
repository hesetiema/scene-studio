// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileBundleUrl } from "../../src/assets/file-bundle";
import { AssetError, AssetErrorCode } from "../../src/assets/asset-error";

let counter = 0;
let created: Blob[] = [];
const revoke = vi.fn();
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  counter = 0;
  created = [];
  revoke.mockClear();
  URL.createObjectURL = ((blob: Blob) => {
    created.push(blob);
    counter += 1;
    return `blob:mock-${counter}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = revoke as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

function file(name: string, content: string | ArrayBuffer): File {
  return new File([content], name);
}

describe("createFileBundleUrl", () => {
  it("hands a self-contained .glb to the loader as one object URL", async () => {
    const bundle = await createFileBundleUrl([file("Fox.glb", "glTF-bytes")]);

    expect(bundle.format).toBe("glb");
    expect(bundle.name).toBe("Fox");
    expect(bundle.url).toBe("blob:mock-1");
    // The asset id keeps the extension: Blob URLs have none, and the universal
    // loader reads the format back off the id.
    expect(bundle.assetId).toBe("upload-Fox.glb");
    expect(created).toHaveLength(1);
  });

  it("inlines a .gltf bundle's buffers and images as Blob URLs", async () => {
    const gltf = {
      asset: { version: "2.0" },
      buffers: [{ uri: "scene.bin", byteLength: 12 }],
      images: [{ uri: "textures/base.png" }],
    };
    const bundle = await createFileBundleUrl([
      file("scene.gltf", JSON.stringify(gltf)),
      file("scene.bin", new ArrayBuffer(12)),
      file("base.png", "png"),
    ]);

    expect(bundle.format).toBe("gltf");
    expect(bundle.name).toBe("scene");
    // bin, png, then the rewritten JSON.
    expect(created).toHaveLength(3);

    const json = JSON.parse(await created[2]!.text()) as typeof gltf;
    expect(json.buffers[0]!.uri).toBe("blob:mock-1");
    expect(json.images[0]!.uri).toBe("blob:mock-2");
  });

  it("matches a percent-encoded relative path", async () => {
    const gltf = { images: [{ uri: "my%20texture.png" }] };
    await createFileBundleUrl([
      file("scene.gltf", JSON.stringify(gltf)),
      file("my texture.png", "png"),
    ]);

    const json = JSON.parse(await created[1]!.text()) as typeof gltf;
    expect(json.images[0]!.uri).toBe("blob:mock-1");
  });

  it("leaves absolute, data and already-blobbed URIs alone", async () => {
    const gltf = {
      buffers: [{ uri: "https://cdn.test/scene.bin" }],
      images: [{ uri: "data:image/png;base64,AAAA" }, { uri: "blob:already-there" }],
    };
    await createFileBundleUrl([file("scene.gltf", JSON.stringify(gltf))]);

    const json = JSON.parse(await created[0]!.text()) as typeof gltf;
    expect(json.buffers[0]!.uri).toBe("https://cdn.test/scene.bin");
    expect(json.images[0]!.uri).toBe("data:image/png;base64,AAAA");
    expect(json.images[1]!.uri).toBe("blob:already-there");
  });

  it("reports which referenced files were not dropped", async () => {
    const gltf = {
      buffers: [{ uri: "missing.bin" }],
      images: [{ uri: "textures/base.png" }],
    };

    await expect(
      createFileBundleUrl([file("scene.gltf", JSON.stringify(gltf))]),
    ).rejects.toMatchObject({
      code: AssetErrorCode.ResolveFailed,
      detail: { missing: ["missing.bin", "textures/base.png"] },
    });
  });

  it("rejects invalid glTF JSON", async () => {
    await expect(createFileBundleUrl([file("scene.gltf", "{not json")])).rejects.toBeInstanceOf(
      AssetError,
    );
  });

  it("prefers the .gltf bundle over a .glb in the same drop", async () => {
    const bundle = await createFileBundleUrl([
      file("model.glb", "glb"),
      file("model.gltf", JSON.stringify({ asset: { version: "2.0" } })),
    ]);

    expect(bundle.format).toBe("gltf");
    expect(bundle.files[0]!.name).toBe("model.gltf");
  });

  it("rejects a drop with no supported file", async () => {
    await expect(createFileBundleUrl([file("notes.txt", "hi")])).rejects.toMatchObject({
      code: AssetErrorCode.UnsupportedFormat,
    });
    await expect(createFileBundleUrl([])).rejects.toMatchObject({
      code: AssetErrorCode.UnsupportedFormat,
    });
  });

  it("revokes every Blob URL it created, once", async () => {
    const bundle = await createFileBundleUrl([
      file("scene.gltf", JSON.stringify({ images: [{ uri: "base.png" }] })),
      file("base.png", "png"),
    ]);

    bundle.dispose();
    bundle.dispose();

    expect(revoke.mock.calls.map((call) => call[0])).toEqual(["blob:mock-1", "blob:mock-2"]);
  });

  it("honours an asset id prefix and keeps the extension last", async () => {
    const bundle = await createFileBundleUrl([file("truck.obj", "o truck")], {
      assetIdPrefix: "upload-7",
    });

    expect(bundle.assetId).toBe("upload-7-truck.obj");
    expect(bundle.format).toBe("obj");
  });
});
