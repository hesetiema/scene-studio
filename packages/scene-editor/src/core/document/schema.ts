import { z } from "zod";

/** Euler XYZ rotation in radians, stored as [x, y, z] (D3). */
export type EulerXYZ = readonly [number, number, number];
export type Vec3 = readonly [number, number, number];

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
  schemaVersion: z.number().int().positive(),
  sceneId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  objects: z.array(SceneObjectSchema),
});

export type SceneObjectDTO = z.infer<typeof SceneObjectSchema>;
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;
