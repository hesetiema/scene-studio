import { z } from "zod";

/** Current on-disk document format. Bump together with a migration (D7/D22). */
export const SCHEMA_VERSION = 2;

/** Euler XYZ rotation in radians, stored as [x, y, z] (D3). */
export type EulerXYZ = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/** Lower-case or upper-case hex, no alpha channel, no named colours (D22). */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

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
  }),
  environment: z.strictObject({
    /** null = transparent background (preserves the pre-D22 look). */
    background: HexColorSchema.nullable(),
    gridVisible: z.boolean(),
  }),
});

export const SceneObjectSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(["mesh", "group"]),
  name: z.string(),
  assetId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  scale: z.tuple([z.number(), z.number(), z.number()]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SceneDocumentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sceneId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  objects: z.array(SceneObjectSchema),
  view: ViewStateSchema,
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type SceneObjectDTO = z.infer<typeof SceneObjectSchema>;
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;
