/** 与框架无关的通风图元层：状态样式 / 聚合链 / 四叉树碰撞 / Media 注册。 */
export type { Bounds, GraphStyle, ModelKind, Rect, ScreenPoint, StateStyleConfig, StateStyles } from "./types";
export { Quadtree, rectsOverlap, type QuadtreeOptions, type RectRef } from "./quadtree";
export { StateStyleTable } from "./state-styles";
export { GraphModel, type GraphModelInit } from "./graph-model";
export { AggregationChain } from "./aggregation-chain";
export { resolveCollisions, type CollisionOptions } from "./collision";
export {
  MediaRegistry,
  frameworkMedia,
  type FrameworkAdapter,
  type Media,
  type MediaContext,
  type MediaFactory,
  type MediaSceneLike,
} from "./media";
export { equipDomMedia, spaceDomMedia } from "./dom-media";
export { GraphScene, type GraphSceneOptions, type Projector } from "./graph-scene";
