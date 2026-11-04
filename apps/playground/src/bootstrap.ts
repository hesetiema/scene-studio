import { DEFAULT_VIEW_STATE, type SceneDocument } from "@scenio/scene-editor";

/** Optimal default camera: comfortable distance ~6.8m, target at mecha center [0, 1.35, 0] */
export const COMFORTABLE_MECHA_CAM_POS: [number, number, number] = [4.5, 2.8, 5.2];
export const COMFORTABLE_MECHA_TARGET: [number, number, number] = [0, 1.35, 0];

/** Complete Assembled Mecha Scene Document (Shells + Torso + Head combined) */
export const mechaAssemblyDoc: SceneDocument = {
  schemaVersion: 2,
  sceneId: "scene-mecha-assembly",
  revision: 0,
  view: {
    ...DEFAULT_VIEW_STATE,
    camera: {
      position: COMFORTABLE_MECHA_CAM_POS,
      target: COMFORTABLE_MECHA_TARGET,
      fov: 48,
    },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.65 },
      directional: { color: "#eef6ff", intensity: 1.35, position: [5, 10, 7] },
    },
    environment: {
      background: "#0c0e12",
      gridVisible: true,
    },
  },
  objects: [
    {
      id: "part-torso",
      type: "mesh",
      name: "躯干内部核心",
      assetId: "mecha-torso",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "part-shells",
      type: "mesh",
      name: "外骨骼装甲外壳",
      assetId: "mecha-shells",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "part-head",
      type: "mesh",
      name: "传感器光学头",
      assetId: "mecha-head",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
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
  const isPrism = assetId === "crystal-prism" || assetId === "tri";
  const target: [number, number, number] = isPrism ? [0, 1.0, 0] : COMFORTABLE_MECHA_TARGET;
  const position: [number, number, number] = isPrism
    ? [3.2, 2.0, 4.0]
    : COMFORTABLE_MECHA_CAM_POS;

  return {
    schemaVersion: 2,
    sceneId: `scene-${assetId}`,
    revision: 0,
    view: {
      ...DEFAULT_VIEW_STATE,
      camera: {
        position,
        target,
        fov: 48,
      },
      lights: {
        ambient: { color: "#ffffff", intensity: 0.65 },
        directional: { color: "#eef6ff", intensity: 1.35, position: [5, 10, 7] },
      },
      environment: {
        background: "#0c0e12",
        gridVisible: true,
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
