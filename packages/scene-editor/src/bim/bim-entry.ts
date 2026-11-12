// BIM integration entry (optional): EffectTool-style Scene.json + binary FBX
// scene assets and BIM outline geometry. Structural only — the loader and the
// geometry helpers carry no materials, units, colours, or camera policy; the
// consumer supplies those through hooks (see API.md §BIM and the vent demo).
// Presentation-layer only — nothing here writes to the scene document.
export {
  parseOutline,
  parseBimLocation,
  outlineToShapes,
  type OutlineJson,
  type OutlinePoint,
  type OutlineToShapesOptions,
} from "./bim-units";
export {
  extrudedOutlineGeometry,
  outlinePlaneGeometry,
  outlinePlanCentroid,
  type ExtrudedOutlineOptions,
  type OutlinePlaneOptions,
} from "./outline-mesh";
export {
  loadRevitFloor,
  type LoadRevitFloorOptions,
  type RevitFloorHandle,
  type RevitFloorMeta,
  type RevitCategoryData,
  type RevitCategoryInfo,
} from "./revit-floor-loader";
export {
  loadBimScene,
  floorKeyOf,
  type LoadBimSceneOptions,
  type BimSceneHandle,
  type BimMeshInfo,
  type MaterialContent,
  type MaterialModel,
  type MeshRenderModel,
  type FbxEntry,
} from "./bim-scene-loader";
