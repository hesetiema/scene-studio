/**
 * 图元层的公共类型——不依赖 three、DOM 框架或任何渲染器。
 * 消费者只需要满足这些结构，就能把同一套碰撞/样式/聚合机制接到自己的图元上。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export type ModelKind = "equip" | "space";

/** 样式是扁平键值表，DOM 媒体与 Vue/React/Solid 媒体都能消费。 */
export interface GraphStyle {
  [key: string]: string | number | boolean;
}

/** 一条状态样式：priority 越大越晚合并（覆盖前面）。 */
export interface StateStyleConfig {
  priority?: number;
  style: GraphStyle;
}

/** 允许直接写 `{ style: {...} }` 或简写成 `{ ... }`（priority 视为 0）。 */
export type StateStyles = Record<string, StateStyleConfig | GraphStyle>;

export interface Bounds {
  icon: Rect | null;
  text: Rect | null;
}
