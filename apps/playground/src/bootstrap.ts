import {
  createDocumentFromAsset,
  createSceneDocument,
  type SceneDocument,
} from "@scenio/scene-editor";

/**
 * Camera baseline for the Khronos samples. They are normalized on load (uniform
 * max dimension), so one comfortable framing works for all of them — the
 * builder only needs the camera patched, the lights/environment stay default.
 */
const SHOWCASE_VIEW = {
  camera: { position: [3.4, 2.1, 3.8] as [number, number, number], target: [0, 1.1, 0] as [number, number, number], fov: 48 },
  environment: { background: "#0c0e12" },
};

/** Default showcase scene: Khronos `DamagedHelmet` (the glTF reference asset). */
export const showcaseDoc: SceneDocument = createSingleModelDoc("damaged-helmet", "Damaged Helmet");

/**
 * Startup document: a valid but empty scene. The element needs a document to
 * boot; the welcome overlay covers it until the user drops a file or picks a
 * sample, so a first visit costs no model download.
 */
export const emptyDoc: SceneDocument = createSceneDocument({
  sceneId: "scene-empty",
  view: {
    camera: { position: [4.2, 2.6, 5], target: [0, 1, 0], fov: 48 },
    // 首页保持纯净：空场景不画网格，载入文档后再按文档的 gridVisible 恢复。
    environment: { background: "#0c0e12", gridVisible: false },
  },
});

/** Default multi-mesh assembly document (for tests and comparative view) */
export const defaultMultiDoc: SceneDocument = createSceneDocument({
  sceneId: "assembly",
  view: {
    camera: { position: [4.6, 2.8, 5.4], target: [0, 0.6, 0], fov: 48 },
    environment: { background: "#0c0e12" },
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
});

/** Create a single-model preset SceneDocument. */
export function createSingleModelDoc(assetId: string, modelTitle: string): SceneDocument {
  return createDocumentFromAsset({
    assetId,
    name: modelTitle,
    sceneId: `scene-${assetId}`,
    view: SHOWCASE_VIEW,
  });
}
