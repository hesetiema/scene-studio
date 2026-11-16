/**
 * 基于四叉树的 AABB 碰撞求解：设备图标聚合 + 文字避让，空间文字避让。
 * 语义沿用参考产品与旧 LabelLayer：按 weight 降序，高权重保留、低权重隐藏；
 * 图标相撞时由高权重者吸收低权重者（可撤销）。
 *
 * 空间文字（房间名 + IoT 读数）是背景信息，设备是前景的可点对象，两者的冲突
 * 分两种处理：图标压住文字时**挪一行**（图标 z 序更高，且文字块大、只被压住
 * 一角，隐藏太贵）；文字互相压住时**按权重让位**（这才是真看不清的情况）。
 * 挪动时压住已定位置的房间名属于硬约束，不参与代价求和，见 hitsSettled。
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

/** 空间文字的候选垂直偏移（px，负值向上）；0 在最前，代价相同就维持原位。 */
const SPACE_AVOID_OFFSETS = [0, -20, 20, -40, 40];

function overlapArea(a: Rect, b: Rect | null): number {
  if (!b) return 0;
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 某一候选位置上，这段空间文字被设备图标和别人设备名压住的总面积（软约束）。 */
function iconCost(
  rect: Rect,
  self: GraphModel,
  iconTree: Quadtree<RectRef<GraphModel>>,
  equipTextTree: Quadtree<RectRef<GraphModel>>,
): number {
  let cost = 0;
  for (const cand of iconTree.retrieve(rect)) {
    if (cand.ref !== self) cost += overlapArea(rect, cand.ref.iconRect);
  }
  for (const cand of equipTextTree.retrieve(rect)) {
    const other = cand.ref;
    if (other === self || other.textHidden) continue;
    cost += overlapArea(rect, other.textRect);
  }
  return cost;
}

/**
 * 是否压住已经定下位置的房间名——这是硬约束，不进代价求和。
 *
 * 房间名按权重降序处理，已定位置的都比我权重高（同级也轮不到我改它），后置的
 * 权重判决藏不掉它，叠在一起就是两块字糊成一片。软代价则相反：它会拿「整块压住
 * 隔壁房间名」去换「少压十来个像素的图标」，方向正好错。
 *
 * 之所以不是完全多余：原位不相交（逃过了高权重者那一轮的判决）却移到别人头上的
 * 情况确实存在，硬约束就是堵这一格。
 */
function hitsSettled(rect: Rect, self: GraphModel, settled: readonly GraphModel[]): boolean {
  for (const other of settled) {
    if (other === self || other.textHidden || !other.textRect) continue;
    if (rectsOverlap(rect, other.textRect)) return true;
  }
  return false;
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
  const settled: GraphModel[] = [];
  for (const a of spaces) {
    if (a.textHidden || !a.textRect) continue;

    // 图标压在文字上时先挪一行，而不是把整块隐藏。实测 B1 平面图：14 个房间里
    // 8 个被图标压住，但压住的面积只有 4%~27%，而且图标绝大多数贴在文字块下缘
    // —— 隐藏会丢掉大半房间名，竖直挪 20px 就能让开。候选里 0 排在最前，
    // 代价相同即维持原位，避免无谓跳动；压到已定位置的房间名上的候选直接作废。
    const base = a.textRect;
    let offset = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const candidate of SPACE_AVOID_OFFSETS) {
      const probe: Rect = { ...base, y: base.y + candidate };
      if (hitsSettled(probe, a, settled)) continue;
      const cost = iconCost(probe, a, iconTree, equipTextTree);
      if (cost < bestCost) {
        bestCost = cost;
        offset = candidate;
      }
      if (cost === 0) break;
    }
    a.textOffsetY = offset;
    const rect: Rect = { ...base, y: base.y + offset };
    a.textRect = rect;
    settled.push(a);

    // 挪开之后仍与设备名相撞时按权重让位：文字互相压住是真看不清，与图标压住
    // 一角不同。权重相同时设备名优先——房间名是背景，设备名是用户要点的对象。
    let conceded = false;
    for (const cand of equipTextTree.retrieve(rect)) {
      const b = cand.ref;
      if (b === a || b.textHidden || !b.textRect) continue;
      if (!rectsOverlap(rect, b.textRect)) continue;
      if (a.weight > b.weight) {
        b.textHidden = true;
        b.textRect = null;
      } else {
        a.textHidden = true;
        a.textRect = null;
        conceded = true;
        break;
      }
    }
    if (conceded) continue;

    for (const cand of spaceTextTree.retrieve(rect)) {
      const b = cand.ref;
      if (b === a || b.textHidden || b.weight > a.weight || !b.textRect) continue;
      if (rectsOverlap(rect, b.textRect)) {
        b.textHidden = true;
        b.textRect = null;
      }
    }
  }
}
