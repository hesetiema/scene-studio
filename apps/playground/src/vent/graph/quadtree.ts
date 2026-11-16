/**
 * 四叉树碰撞索引（参考产品的 maxObjects=30 / maxLevels=10 口径）。
 *
 * 与原 O(n²) 双重循环相比：只对「与查询矩形可能相交的子树」做检测。
 * 节点中只放**完全落入该象限**的条目，跨象限的留在父节点，因此同一条目
 * 在树中只有一份，retrieve 结果天然去重。
 */
import type { Rect } from "./types";

export function rectsOverlap(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return false;
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

function intersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 带归属对象的矩形条目，供碰撞求解器把命中结果映射回图元模型。 */
export interface RectRef<T> extends Rect {
  ref: T;
}

export interface QuadtreeOptions {
  maxObjects?: number;
  maxLevels?: number;
  level?: number;
}

export class Quadtree<T extends Rect> {
  readonly bounds: Rect;
  readonly level: number;
  readonly maxObjects: number;
  readonly maxLevels: number;
  items: T[] = [];
  nodes: Quadtree<T>[] = [];

  constructor(bounds: Rect, options: QuadtreeOptions = {}) {
    this.bounds = bounds;
    this.level = options.level ?? 0;
    this.maxObjects = options.maxObjects ?? 30;
    this.maxLevels = options.maxLevels ?? 10;
  }

  insert(item: T): void {
    if (this.nodes.length > 0) {
      const index = this.#indexOf(item);
      if (index >= 0) {
        this.nodes[index]!.insert(item);
        return;
      }
    }
    this.items.push(item);
    if (this.items.length > this.maxObjects && this.level < this.maxLevels && this.nodes.length === 0) {
      this.#split();
    }
  }

  /** 返回与 rect 相交的所有条目（含祖先节点上跨象限的条目）。 */
  retrieve(rect: Rect, out: T[] = []): T[] {
    if (!intersects(this.bounds, rect)) return out;
    for (const item of this.items) if (intersects(item, rect)) out.push(item);
    for (const node of this.nodes) node.retrieve(rect, out);
    return out;
  }

  clear(): void {
    this.items.length = 0;
    for (const node of this.nodes) node.clear();
    this.nodes.length = 0;
  }

  #indexOf(item: Rect): number {
    const midX = this.bounds.x + this.bounds.w / 2;
    const midY = this.bounds.y + this.bounds.h / 2;
    const top = item.y >= this.bounds.y && item.y + item.h <= midY;
    const bottom = item.y >= midY && item.y + item.h <= this.bounds.y + this.bounds.h;
    const left = item.x >= this.bounds.x && item.x + item.w <= midX;
    const right = item.x >= midX && item.x + item.w <= this.bounds.x + this.bounds.w;
    if (top) {
      if (left) return 0;
      if (right) return 1;
    } else if (bottom) {
      if (left) return 2;
      if (right) return 3;
    }
    return -1;
  }

  #split(): void {
    const { x, y, w, h } = this.bounds;
    const hw = w / 2;
    const hh = h / 2;
    const opts = { maxObjects: this.maxObjects, maxLevels: this.maxLevels, level: this.level + 1 };
    this.nodes = [
      new Quadtree<T>({ x, y, w: hw, h: hh }, opts),
      new Quadtree<T>({ x: x + hw, y, w: hw, h: hh }, opts),
      new Quadtree<T>({ x, y: y + hh, w: hw, h: hh }, opts),
      new Quadtree<T>({ x: x + hw, y: y + hh, w: hw, h: hh }, opts),
    ];
    const keep: T[] = [];
    for (const item of this.items) {
      const index = this.#indexOf(item);
      if (index >= 0) this.nodes[index]!.insert(item);
      else keep.push(item);
    }
    this.items = keep;
  }
}
