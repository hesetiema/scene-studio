import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  SceneDocumentSchema,
  ViewStateSchema,
  type SceneObjectDTO,
} from "../../src/core/document/schema";
import { createDefaultViewState } from "../../src/core/document/default-view";

const validObject: SceneObjectDTO = {
  id: "obj-1",
  type: "mesh",
  name: "Box",
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

const validDoc = {
  schemaVersion: SCHEMA_VERSION,
  sceneId: "scene-1",
  revision: 0,
  objects: [validObject],
  view: createDefaultViewState(),
};

describe("ViewStateSchema", () => {
  it("accepts the engine defaults", () => {
    expect(ViewStateSchema.safeParse(createDefaultViewState()).success).toBe(true);
  });

  it("accepts a custom view", () => {
    const view = {
      camera: { position: [-2, 8, 3], target: [1, 0, -1], fov: 45 },
      lights: {
        ambient: { color: "#ff00aa", intensity: 0.2 },
        directional: { color: "#00ff00", intensity: 2, position: [0, 5, 0] },
      },
      environment: { background: "#101010", gridVisible: false },
    };
    expect(ViewStateSchema.safeParse(view).success).toBe(true);
  });

  it("requires #rrggbb colours", () => {
    const bad = createDefaultViewState();
    bad.lights.ambient.color = "white";
    expect(ViewStateSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects non-positive fov and negative intensity", () => {
    const zeroFov = createDefaultViewState();
    zeroFov.camera.fov = 0;
    expect(ViewStateSchema.safeParse(zeroFov).success).toBe(false);

    const negative = createDefaultViewState();
    negative.lights.ambient.intensity = -1;
    expect(ViewStateSchema.safeParse(negative).success).toBe(false);
  });

  it("rejects unknown keys inside the view (strict)", () => {
    const bad = { ...createDefaultViewState(), near: 0.1 };
    expect(ViewStateSchema.safeParse(bad).success).toBe(false);
  });
});

describe("SceneDocumentSchema", () => {
  it("accepts a minimal valid document", () => {
    const result = SceneDocumentSchema.safeParse(validDoc);
    expect(result.success).toBe(true);
  });

  it("accepts assetId, parentId and metadata when present", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [
        {
          ...validObject,
          assetId: "asset-42",
          parentId: "obj-root",
          metadata: { locked: true },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires rotation to be a 3-number tuple (Euler XYZ radians)", () => {
    const bad = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, rotation: [0, 0] }],
    });
    expect(bad.success).toBe(false);
  });

  it("requires schemaVersion, sceneId and revision", () => {
    expect(SceneDocumentSchema.safeParse({ ...validDoc, schemaVersion: undefined }).success).toBe(false);
    expect(SceneDocumentSchema.safeParse({ ...validDoc, sceneId: "" }).success).toBe(false);
    expect(SceneDocumentSchema.safeParse({ ...validDoc, revision: -1 }).success).toBe(false);
  });

  it("rejects unknown object types", () => {
    const bad = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, type: "light" }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const bad = SceneDocumentSchema.safeParse({ ...validDoc, extra: true });
    expect(bad.success).toBe(false);
  });

  it("metadata must be a plain object when present", () => {
    const bad = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, metadata: "nope" }],
    });
    expect(bad.success).toBe(false);
  });

  it("requires the view section (v2 is fully explicit)", () => {
    const { view: _view, ...withoutView } = validDoc;
    expect(SceneDocumentSchema.safeParse(withoutView).success).toBe(false);
  });

  it("rejects the previous schema version literal", () => {
    expect(SceneDocumentSchema.safeParse({ ...validDoc, schemaVersion: 1 }).success).toBe(false);
  });
});

describe("SceneDocumentSchema v3: primitives", () => {
  const primitive = {
    ...validObject,
    id: "prim-1",
    type: "primitive" as const,
    geometry: { kind: "sphere" as const, radius: 2 },
  };

  it("accepts a primitive with geometry", () => {
    const result = SceneDocumentSchema.safeParse({ ...validDoc, objects: [primitive] });
    expect(result.success).toBe(true);
  });

  it("rejects a primitive without geometry", () => {
    const { geometry: _geometry, ...withoutGeometry } = primitive;
    const result = SceneDocumentSchema.safeParse({ ...validDoc, objects: [withoutGeometry] });
    expect(result.success).toBe(false);
  });

  it("rejects geometry on a mesh", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, geometry: { kind: "box" } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects assetId on a primitive", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...primitive, assetId: "asset-1" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown geometry kind", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...primitive, geometry: { kind: "dodecahedron" } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown geometry parameters (strict)", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...primitive, geometry: { kind: "sphere", radious: 2 } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive geometry sizes", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...primitive, geometry: { kind: "sphere", radius: 0 } }],
    });
    expect(result.success).toBe(false);
  });
});

describe("SceneDocumentSchema v3: material", () => {
  it("accepts a partial material override", () => {
    const result = SceneDocumentSchema.safeParse({
      ...validDoc,
      objects: [{ ...validObject, material: { color: "#ff8800", metalness: 0.8 } }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-range roughness / opacity", () => {
    for (const material of [{ roughness: 2 }, { opacity: -0.1 }]) {
      const result = SceneDocumentSchema.safeParse({
        ...validDoc,
        objects: [{ ...validObject, material }],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects named colours and unknown material keys", () => {
    for (const material of [{ color: "red" }, { albedo: "#ffffff" }]) {
      const result = SceneDocumentSchema.safeParse({
        ...validDoc,
        objects: [{ ...validObject, material }],
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("ViewStateSchema v3: additional lights", () => {
  it("keeps the two fixed light slots optional-free", () => {
    const view = createDefaultViewState();
    expect(ViewStateSchema.safeParse(view).success).toBe(true);
    expect(view.lights.additional).toBeUndefined();
  });

  it("accepts extra lights", () => {
    const view = createDefaultViewState();
    view.lights.additional = [
      { kind: "point", color: "#ffffff", intensity: 2, position: [1, 2, 3] },
      { kind: "hemisphere", skyColor: "#ffffff", groundColor: "#222222", intensity: 0.5 },
    ];
    expect(ViewStateSchema.safeParse(view).success).toBe(true);
  });

  it("rejects unknown light kinds and missing positions", () => {
    const view = createDefaultViewState();
    view.lights.additional = [{ kind: "laser", color: "#ffffff", intensity: 1 }] as never;
    expect(ViewStateSchema.safeParse(view).success).toBe(false);

    const missing = createDefaultViewState();
    missing.lights.additional = [{ kind: "point", color: "#ffffff", intensity: 1 }] as never;
    expect(ViewStateSchema.safeParse(missing).success).toBe(false);
  });
});
