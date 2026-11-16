/**
 * 基于四叉树的 AABB 碰撞求解：设备图标聚合 + 文字避让，空间文字避让。
 * 语义沿用参考产品与旧 LabelLayer：按 weight 降序，高权重保留、低权重隐藏；
 * 图标相撞时由高权重者吸收低权重者（可撤销）。
 */
import type { AggregationChain } from "./aggregation-chain";
import type { GraphModel } from "./graph-model";
import { Quadtree, rectsOverlap, type RectRef } from "./quadtree";
import type { Rect } from "./types";

export interface CollisionOptions {
  bounds: Rect;
  maxObjects?: number;
  maxLevels?: number;
}

export function resolveCollisions(
  models: readonly GraphModel[],
  chain: AggregationChain,
  options: CollisionOptions,
): void {
  // 先逆序回滚上一帧，保证每一帧的聚合链都是干净的、可追溯的
  chain.clear();

  const visible = models.filter((m) => m.visible && (m.iconRect || m.textRect));
  for (const m of visible) {
    m.iconHidden = false;
    m.textHidden = false;
  }

  const treeOptions = { maxObjects: options.maxObjects ?? 30, maxLevels: options.maxLevels ?? 10 };
  const equips = visible
    .filter((m) => m.kind === "equip")
    .sort((a, b) => b.weight - a.weight);
  const spaces = visible
    .filter((m) => m.kind === "space")
    .sort((a, b) => b.weight - a.weight);

  const iconTree = new Quadtree<RectRef<GraphModel>>(options.bounds, treeOptions);
  const equipTextTree = new Quadtree<RectRef<GraphModel>>(options.bounds, treeOptions);
  for (const m of equips) {
    if (m.iconRect) iconTree.insert({ ...m.iconRect, ref: m });
    if (m.textRect) equipTextTree.insert({ ...m.textRect, ref: m });
  }

  for (const a of equips) {
    if (a.isAbsorbed) continue;
    // 每个对手本帧只判一种冲突，与旧实现「break after first pair」一致
    const handled = new Set<GraphModel>();
    const visit = (candidates: readonly RectRef<GraphModel>[], kind: "icon" | "a-text"): void => {
      for (const cand of candidates) {
        const b = cand.ref;
        if (b === a || b.isAbsorbed || handled.has(b) || b.weight > a.weight) continue;
        if (kind === "icon" && a.iconRect && b.iconRect && rectsOverlap(a.iconRect, b.iconRect)) {
          chain.absorb(a, b);
          b.iconHidden = true;
          b.textHidden = true;
          handled.add(b);
          continue;
        }
        if (kind === "icon" && a.iconRect && b.textRect && rectsOverlap(a.iconRect, b.textRect)) {
          b.textHidden = true;
          handled.add(b);
          continue;
        }
        if (kind === "a-text" && a.textRect && b.iconRect && rectsOverlap(a.textRect, b.iconRect)) {
          a.textHidden = true;
          handled.add(b);
          continue;
        }
        if (kind === "a-text" && a.textRect && b.textRect && rectsOverlap(a.textRect, b.textRect)) {
          b.textHidden = true;
          handled.add(b);
        }
      }
    };

    if (a.iconRect) {
      visit(iconTree.retrieve(a.iconRect), "icon");
      visit(equipTextTree.retrieve(a.iconRect), "icon");
    }
    // a.text 重叠 b.icon 时牺牲 a 的文字；不需要再查已处理过的 b
    if (a.textRect) visit(iconTree.retrieve(a.textRect), "a-text");
    if (a.textRect && !a.textHidden) visit(equipTextTree.retrieve(a.textRect), "a-text");
  }

  const spaceTextTree = new Quadtree<RectRef<GraphModel>>(options.bounds, treeOptions);
  for (const m of spaces) {
    if (m.textRect) spaceTextTree.insert({ ...m.textRect, ref: m });
  }
  for (const a of spaces) {
    if (a.textHidden || !a.textRect) continue;
    for (const cand of spaceTextTree.retrieve(a.textRect)) {
      const b = cand.ref;
      if (b === a || b.textHidden || b.weight > a.weight || !b.textRect) continue;
      if (rectsOverlap(a.textRect, b.textRect)) {
        b.textHidden = true;
        b.textRect = null;
      }
    }
  }
}
