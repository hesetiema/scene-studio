// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEditorElement } from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import type { AssetResolver } from "../../src/assets/resolver-asset-loader";
import { AssetErrorCode } from "../../src/assets/asset-error";
import { SceneEditorError, SceneErrorCode } from "../../src/core/events/errors";

const ORIGINAL_FACTORY = SceneEditorElement.runtimeFactory;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let created = 0;
let revoked: string[] = [];

function file(name: string, content: string): File {
  return new File([content], name);
}

interface Harness {
  el: SceneEditorElement;
  fake: FakeRuntime;
  resolver: () => AssetResolver | undefined;
}

function makeElement(): Harness {
  const fake = new FakeRuntime();
  let captured: AssetResolver | undefined;
  SceneEditorElement.runtimeFactory = (_canvas, options) => {
    captured = options?.assetResolver;
    return fake;
  };
  const el = document.createElement("scene-editor") as SceneEditorElement;
  return { el, fake, resolver: () => captured };
}

async function connected(el: SceneEditorElement): Promise<void> {
  document.body.appendChild(el);
  await el.ready;
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  created = 0;
  revoked = [];
  URL.createObjectURL = ((_blob: Blob) => `blob:test-${++created}`) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_FACTORY;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("loadFiles", () => {
  it("synthesizes a preview document and resolves its asset through the bundle", async () => {
    const { el, fake, resolver } = makeElement();
    await connected(el);

    await el.loadFiles([file("Fox.glb", "glb-bytes")]);

    const doc = fake.calls.loadDocument.at(-1)!;
    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0]).toMatchObject({
      assetId: "upload-1-Fox.glb",
      name: "Fox",
      id: "upload-1-Fox.glb-mesh",
    });
    // Preview baseline, not editor defaults: no grid, model-viewer framing.
    expect(doc.view.environment.gridVisible).toBe(false);
    expect(doc.view.camera.fov).toBe(30);
    // The reserved id resolves to the Blob URL the bundle created.
    await expect(resolver()!.resolve("upload-1-Fox.glb")).resolves.toBe("blob:test-1");
    // A host did not hand us a document: this is a viewer.
    expect(el.mode).toBe("viewer");
  });

  it("revokes the previous bundle on the next load, not before", async () => {
    const { el } = makeElement();
    await connected(el);

    await el.loadFiles([file("Fox.glb", "one")]);
    expect(revoked).toEqual([]);

    await el.loadFiles([file("Fox.glb", "two")]);
    expect(revoked).toEqual(["blob:test-1"]);
  });

  it("revokes on disconnect", async () => {
    const { el } = makeElement();
    await connected(el);
    await el.loadFiles([file("Fox.glb", "one")]);

    el.remove();
    expect(revoked).toEqual(["blob:test-1"]);
  });

  it("rejects an unsupported drop without touching the document", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    const before = fake.calls.loadDocument.length;

    await expect(el.loadFiles([file("notes.txt", "hi")])).rejects.toMatchObject({
      code: AssetErrorCode.UnsupportedFormat,
    });
    expect(fake.calls.loadDocument).toHaveLength(before);
  });

  it("resolves the uploaded asset even when the host owns a resolver", async () => {
    const { el, fake, resolver } = makeElement();
    const host = { resolve: vi.fn(async (id: string) => `/assets/${id}.glb`) };
    el.assetResolver = host;
    await connected(el);

    await el.loadFiles([file("Fox.glb", "glb-bytes")]);

    expect(await resolver()!.resolve("upload-1-Fox.glb")).toBe("blob:test-1");
    // The host table never saw the element's private id.
    expect(host.resolve).not.toHaveBeenCalled();
    // ...and host ids still go to the host.
    await expect(resolver()!.resolve("fox")).resolves.toBe("/assets/fox.glb");
    expect(fake.calls.loadDocument.at(-1)!.objects[0]!.assetId).toBe("upload-1-Fox.glb");
  });

  it("keeps two drops of the same file name apart in the asset cache", async () => {    const { el, fake } = makeElement();
    await connected(el);

    await el.loadFiles([file("Fox.glb", "one")]);
    await el.loadFiles([file("Fox.glb", "two")]);

    const ids = fake.calls.loadDocument.map((doc) => doc.objects[0]!.assetId);
    expect(ids).toEqual(["upload-1-Fox.glb", "upload-2-Fox.glb"]);
    expect(created).toBe(2);
  });
});

describe("exportDocument", () => {
  it("serializes the current document through the runtime", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadFiles([file("Fox.glb", "glb-bytes")]);

    const blob = await el.exportDocument({ format: "obj" });

    expect(await blob.text()).toBe("fake-export");
    const call = fake.calls.exportDocument.at(-1)!;
    expect(call.format).toBe("obj");
    expect(call.doc.objects[0]!.assetId).toBe("upload-1-Fox.glb");
  });

  it("defaults to glb", async () => {
    const { el, fake } = makeElement();
    await connected(el);
    await el.loadFiles([file("Fox.glb", "glb-bytes")]);

    await el.exportDocument();

    expect(fake.calls.exportDocument.at(-1)!.format).toBe("glb");
  });

  it("rejects with a stable code when the runtime cannot export", async () => {
    const { el } = makeElement();
    await connected(el);
    // A custom runtime that only paints pixels: `exportDocument` is optional.
    Object.defineProperty(el.runtime, "exportDocument", { value: undefined });

    await expect(el.exportDocument()).rejects.toBeInstanceOf(SceneEditorError);
    await expect(el.exportDocument()).rejects.toMatchObject({ code: SceneErrorCode.Lifecycle });
  });
});
