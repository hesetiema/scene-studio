import { DEFAULT_VIEW_STATE, type SceneDocument } from "@scenio/scene-editor";

/**
 * Default camera baseline. Khronos sample assets are normalized on load
 * (uniform max dimension), so one comfortable framing works for all of them.
 */
export const SHOWCASE_CAM_POS: [number, number, number] = [3.4, 2.1, 3.8];
export const SHOWCASE_TARGET: [number, number, number] = [0, 1.1, 0];

/** Default showcase scene: Khronos `DamagedHelmet` (the glTF reference asset). */
export const showcaseDoc: SceneDocument = createSingleModelDoc("damaged-helmet", "Damaged Helmet");

/**
 * Startup document: a valid but empty scene. The element needs a document to
 * boot; the welcome overlay covers it until the user drops a file or picks a
 * sample, so a first visit costs no model download.
 */
export const emptyDoc: SceneDocument = {
  schemaVersion: 2,
  sceneId: "scene-empty",
  revision: 0,
  view: {
    ...DEFAULT_VIEW_STATE,
    camera: { position: [4.2, 2.6, 5], target: [0, 1, 0], fov: 48 },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.65 },
      directional: { color: "#eef6ff", intensity: 1.35, position: [5, 10, 7] },
    },
    environment: {
      background: "#0c0e12",
      // 首页保持纯净：空场景不画网格，载入文档后再按文档的 gridVisible 恢复。
      gridVisible: false,
      iblIntensity: 1,
    },
  },
  objects: [],
};

/** Default multi-mesh assembly document (for tests and comparative view) */
export const defaultMultiDoc: SceneDocument = {
  schemaVersion: 2,
  sceneId: "assembly",
  revision: 0,
  view: {
    ...DEFAULT_VIEW_STATE,
    camera: {
      position: [4.6, 2.8, 5.4],
      target: [0, 0.6, 0],
      fov: 48,
    },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.65 },
      directional: { color: "#eef6ff", intensity: 1.35, position: [5, 10, 7] },
    },
    environment: {
      background: "#0c0e12",
      gridVisible: true,
      iblIntensity: 1,
    },
  },
  objects: [
    {
      id: "box-1",
      type: "mesh",
      name: "几何体 A",
      position: [0, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "box-2",
      type: "mesh",
      name: "几何体 B",
      position: [2, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "gem-1",
      type: "mesh",
      name: "多面核心宝石",
      assetId: "gem",
      position: [-2, 0.7, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

/** Create a single-model preset SceneDocument. */
export function createSingleModelDoc(assetId: string, modelTitle: string): SceneDocument {
  return {
    schemaVersion: 2,
    sceneId: `scene-${assetId}`,
    revision: 0,
    view: {
      ...DEFAULT_VIEW_STATE,
      camera: {
        position: SHOWCASE_CAM_POS,
        target: SHOWCASE_TARGET,
        fov: 48,
      },
      lights: {
        ambient: { color: "#ffffff", intensity: 0.65 },
        directional: { color: "#eef6ff", intensity: 1.35, position: [5, 10, 7] },
      },
      environment: {
        background: "#0c0e12",
        gridVisible: true,
        iblIntensity: 1,
      },
    },
    objects: [
      {
        id: `${assetId}-mesh`,
        type: "mesh",
        name: modelTitle,
        assetId: assetId,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
  };
}
