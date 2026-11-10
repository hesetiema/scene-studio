import { z } from "zod";

/** Current on-disk document format. Bump together with a migration (D7/D22). */
export const SCHEMA_VERSION = 5;

/** Euler XYZ rotation in radians, stored as [x, y, z] (D3). */
export type EulerXYZ = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Lower-case or upper-case hex, no alpha channel, no named colours (D22). */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const Segments = z.number().int().min(1);
const RadialSegments = z.number().int().min(3);
const Detail = z.number().int().min(0);

/**
 * Procedural geometry primitives (v3). Every parameter is optional; the three
 * factory applies the documented default, so a document stores only what it
 * changed. Unknown parameters are rejected, not ignored.
 */
export const PrimitiveGeometrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("box"),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    depth: z.number().positive().optional(),
    widthSegments: Segments.optional(),
    heightSegments: Segments.optional(),
    depthSegments: Segments.optional(),
  }),
  z.strictObject({
    kind: z.literal("sphere"),
    radius: z.number().positive().optional(),
    widthSegments: RadialSegments.optional(),
    heightSegments: z.number().int().min(2).optional(),
  }),
  z.strictObject({
    kind: z.literal("cylinder"),
    radiusTop: z.number().nonnegative().optional(),
    radiusBottom: z.number().nonnegative().optional(),
    height: z.number().positive().optional(),
    radialSegments: RadialSegments.optional(),
  }),
  z.strictObject({
    kind: z.literal("cone"),
    radius: z.number().positive().optional(),
    height: z.number().positive().optional(),
    radialSegments: RadialSegments.optional(),
  }),
  z.strictObject({
    kind: z.literal("torus"),
    radius: z.number().positive().optional(),
    tube: z.number().positive().optional(),
    radialSegments: RadialSegments.optional(),
    tubularSegments: RadialSegments.optional(),
  }),
  z.strictObject({
    kind: z.literal("plane"),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    widthSegments: Segments.optional(),
    heightSegments: Segments.optional(),
  }),
  z.strictObject({
    kind: z.literal("capsule"),
    radius: z.number().positive().optional(),
    length: z.number().nonnegative().optional(),
    capSegments: Segments.optional(),
    radialSegments: RadialSegments.optional(),
  }),
  z.strictObject({
    kind: z.literal("icosahedron"),
    radius: z.number().positive().optional(),
    detail: Detail.optional(),
  }),
]);

/**
 * Material override (v3). Only the fields present are written; everything else
 * keeps the value it had — a GLB's own material survives a colour-only override.
 * `opacity < 1` implies `transparent`, so there is no separate flag to get wrong.
 */
export const MaterialSchema = z.strictObject({
  color: HexColorSchema.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  emissive: HexColorSchema.optional(),
  emissiveIntensity: z.number().nonnegative().optional(),
  opacity: z.number().min(0).max(1).optional(),
  flatShading: z.boolean().optional(),
  wireframe: z.boolean().optional(),
  /**
   * Texture maps (v4). Values are **asset ids**, never URLs: the host's
   * AssetResolver decides where bytes live, so a saved document survives a CDN
   * move or a bucket rename.
   */
  map: z.string().min(1).optional(),
  roughnessMap: z.string().min(1).optional(),
  normalMap: z.string().min(1).optional(),
  /** normalMap strength; ignored without `normalMap`. */
  normalScale: z.number().optional(),
  /** UV repeat applied to every map in this material. */
  textureRepeat: z.tuple([z.number().positive(), z.number().positive()]).optional(),
});

/**
 * Lights beyond the two `view.lights` slots the studio presets rely on (v3).
 * Kept as an add-on array instead of reshaping `lights` so v2 documents and the
 * preset UI keep working unchanged.
 */
export const AdditionalLightSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("directional"),
    color: HexColorSchema,
    intensity: z.number().nonnegative(),
    position: Vec3Schema,
    target: Vec3Schema.optional(),
  }),
  z.strictObject({
    kind: z.literal("point"),
    color: HexColorSchema,
    intensity: z.number().nonnegative(),
    position: Vec3Schema,
    distance: z.number().nonnegative().optional(),
    decay: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("spot"),
    color: HexColorSchema,
    intensity: z.number().nonnegative(),
    position: Vec3Schema,
    target: Vec3Schema.optional(),
    angle: z.number().positive().optional(),
    penumbra: z.number().min(0).max(1).optional(),
    distance: z.number().nonnegative().optional(),
    decay: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("hemisphere"),
    skyColor: HexColorSchema,
    groundColor: HexColorSchema,
    intensity: z.number().nonnegative(),
  }),
]);

/**
 * HDR environment (v4). An asset id, never a URL — the host's resolver owns
 * where the bytes live (same rule as `material.map`).
 */
export const EnvironmentHdrSchema = z.strictObject({
  assetId: z.string().min(1),
  /** Multiplier on the prefiltered map; falls back to `iblIntensity`. */
  intensity: z.number().nonnegative().optional(),
  /** Use the HDR as the visible backdrop too (default false: IBL only). */
  asBackground: z.boolean().optional(),
});

/**
 * Skybox (v5): a visible backdrop that is **independent** of the IBL. model-viewer
 * splits `skybox-image` from `environment-image`; so does this.
 */
export const EnvironmentSkyboxSchema = z.strictObject({
  assetId: z.string().min(1),
  /** Background brightness (0..4). Defaults to 1. */
  intensity: z.number().nonnegative().optional(),
});

/** Contact shadow (v4): a soft catch plane under the content. */
export const ContactShadowSchema = z.strictObject({
  enabled: z.boolean(),
  /**
   * 0..1; higher is darker. model-viewer's `shadow-intensity`: in range 0..1 it
   * is the catcher's ceiling opacity, eased down automatically for hard
   * shadows. Missing means 1.
   */
  opacity: z.number().min(0).max(1).optional(),
  /** Plane offset from y = 0, for content that sits below the origin. */
  height: z.number().optional(),
  /**
   * 0..1, model-viewer's `shadow-softness`. Drives the shadow texture's
   * resolution and the height range that feeds it: crisp keeps only the contact
   * band just above the floor, soft lets the whole model contribute. Missing
   * means 1 (softest).
   */
  softness: z.number().min(0).max(1).optional(),
});

/** Camera / lights / environment — the persisted "what it looks like" (D22). */
export const ViewStateSchema = z.strictObject({
  camera: z.strictObject({
    position: Vec3Schema,
    target: Vec3Schema,
    fov: z.number().positive(),
  }),
  lights: z.strictObject({
    ambient: z.strictObject({
      color: HexColorSchema,
      intensity: z.number().nonnegative(),
    }),
    directional: z.strictObject({
      color: HexColorSchema,
      intensity: z.number().nonnegative(),
      position: Vec3Schema,
    }),
    /**
     * Extra lights (v3). Optional: documents written before v3 and the studio
     * presets keep the two fixed slots; missing means "none".
     */
    additional: z.array(AdditionalLightSchema).optional(),
  }),
  environment: z.strictObject({
    /** null = transparent background (preserves the pre-D22 look). */
    background: HexColorSchema.nullable(),
    gridVisible: z.boolean(),
    /**
     * Image-based lighting strength (0 = analytic lights only). Optional so v2
     * documents written before IBL existed still parse; missing means
     * `DEFAULT_IBL_INTENSITY`.
     */
    iblIntensity: z.number().nonnegative().optional(),
    /**
     * HDR / EXR environment (v4), resolved through the host's AssetResolver.
     * Missing = the built-in studio room, so v3 documents keep their look.
     */
    hdr: EnvironmentHdrSchema.optional(),
    /**
     * Visible backdrop (v5), independent of `hdr`: a panorama here changes only
     * what you see behind the model, not what it reflects.
     */
    skybox: EnvironmentSkyboxSchema.optional(),
    /** Soft ground shadow under the content (v4). Missing = off. */
    contactShadow: ContactShadowSchema.optional(),
  }),
});

export const SceneObjectSchema = z
  .strictObject({
    id: z.string().min(1),
    type: z.enum(["mesh", "group", "primitive"]),
    name: z.string(),
    /** Asset-backed mesh only. Rejected on `primitive` by the refine below. */
    assetId: z.string().min(1).optional(),
    parentId: z.string().min(1).optional(),
    /** Procedural geometry, required for `primitive` and unused otherwise. */
    geometry: PrimitiveGeometrySchema.optional(),
    /** Per-object material override; applies to primitives and to asset meshes. */
    material: MaterialSchema.optional(),
    position: z.tuple([z.number(), z.number(), z.number()]),
    rotation: z.tuple([z.number(), z.number(), z.number()]),
    scale: z.tuple([z.number(), z.number(), z.number()]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((object) => object.type !== "primitive" || object.geometry !== undefined, {
    message: "primitive objects require geometry",
    path: ["geometry"],
  })
  .refine((object) => object.type === "primitive" || object.geometry === undefined, {
    message: "geometry is only valid on primitive objects",
    path: ["geometry"],
  })
  .refine((object) => object.type !== "primitive" || object.assetId === undefined, {
    message: "primitive objects cannot carry an assetId",
    path: ["assetId"],
  });

export const SceneDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sceneId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  objects: z.array(SceneObjectSchema),
  view: ViewStateSchema,
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type EnvironmentHdrDTO = z.infer<typeof EnvironmentHdrSchema>;
export type EnvironmentSkyboxDTO = z.infer<typeof EnvironmentSkyboxSchema>;
export type ContactShadowDTO = z.infer<typeof ContactShadowSchema>;
export type AdditionalLightDTO = z.infer<typeof AdditionalLightSchema>;
export type PrimitiveGeometry = z.infer<typeof PrimitiveGeometrySchema>;
export type MaterialDTO = z.infer<typeof MaterialSchema>;
export type SceneObjectType = SceneObjectDTO["type"];
export type SceneObjectDTO = z.infer<typeof SceneObjectSchema>;
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;
