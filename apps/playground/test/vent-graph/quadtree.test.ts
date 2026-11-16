import { describe, expect, it } from "vitest";
import { Quadtree, rectsOverlap } from "../../src/vent/graph/quadtree";
import type { Rect } from "../../src/vent/graph/types";

const rect = (x: number, y: number, w = 10, h = 10): Rect => ({ x, y, w, h });
/** 100×100 的树，中线在 50，方便写「跨象限 / 同象限」两类用例。 */
const bounds = (): Rect => ({ x: 0, y: 0, w: 100, h: 100 });

describe("rectsOverlap", () => {
  it("null 任一侧都不算重叠（未投影或已隐藏的图元走这条）", () => {
    expect(rectsOverlap(null, rect(0, 0))).toBe(false);
    expect(rectsOverlap(rect(0, 0), null)).toBe(false);
    expect(rectsOverlap(null, null)).toBe(false);
  });

  it("部分相交与包含都算重叠", () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true);
    expect(rectsOverlap(rect(0, 0, 30, 30), rect(5, 5, 2, 2))).toBe(true);
  });

  it("完全分离不算重叠", () => {
    expect(rectsOverlap(rect(0, 0), rect(200, 200))).toBe(false);
  });

  it("边贴合也算重叠——判据是闭区间，共用一条边的图元会被视为互相压住", () => {
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(true);
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(0, 10, 10, 10))).toBe(true);
    // 隔开 1px 才是真的不重叠
    expect(rectsOverlap(rect(0, 0, 10, 10), rect(11, 0, 10, 10))).toBe(false);
  });
});

describe("Quadtree insert / retrieve", () => {
  it("未超过 maxObjects 时不分裂，条目留在根节点", () => {
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 4 });
    tree.insert(rect(0, 0));
    tree.insert(rect(20, 20));
    expect(tree.nodes).toHaveLength(0);
    expect(tree.items).toHaveLength(2);
  });

  it("超过 maxObjects 后分裂成四个象限，条目被下沉", () => {
    // maxLevels=1：允许根分裂一次，子节点不再分裂，便于断言下沉结果
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 1, maxLevels: 1 });
    tree.insert(rect(0, 0, 5, 5));
    expect(tree.nodes).toHaveLength(0);
    tree.insert(rect(6, 6, 5, 5));
    expect(tree.nodes).toHaveLength(4);
    // 两个都在左上象限；父节点只留下跨象限的条目（此处为空）
    expect(tree.items).toHaveLength(0);
    expect(tree.nodes[0]!.items).toHaveLength(2);
  });

  it("子节点仍满时继续向下分裂，深度受 maxLevels 约束", () => {
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 1, maxLevels: 4 });
    tree.insert(rect(0, 0, 5, 5));
    tree.insert(rect(6, 6, 5, 5));

    // 左上象限自己又分裂了一次，条目继续下沉
    expect(tree.nodes[0]!.nodes).toHaveLength(4);
    expect(tree.nodes[0]!.items).toHaveLength(0);
  });

  it("跨象限的条目留在父节点，仍能被 retrieve 命中", () => {
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 1, maxLevels: 4 });
    const straddling = rect(40, 40, 20, 20); // 压住中线 x=50 / y=50
    tree.insert(straddling);
    tree.insert(rect(0, 0, 5, 5));
    tree.insert(rect(6, 6, 5, 5));
    expect(tree.nodes).toHaveLength(4);
    expect(tree.items).toContain(straddling);
    expect(tree.retrieve(rect(45, 45, 2, 2))).toContain(straddling);
  });

  it("retrieve 只返回相交条目，且同一条目不会重复出现", () => {
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 2, maxLevels: 4 });
    const items = [rect(0, 0, 5, 5), rect(60, 0, 5, 5), rect(0, 60, 5, 5), rect(60, 60, 5, 5), rect(48, 48, 4, 4)];
    for (const item of items) tree.insert(item);

    const hit = tree.retrieve(rect(0, 0, 5, 5));
    expect(hit).toEqual([items[0]]);

    const all = tree.retrieve(bounds());
    expect(all).toHaveLength(items.length);
    expect(new Set(all).size).toBe(items.length);
  });

  it("完全落在 bounds 外的查询直接返回空", () => {
    const tree = new Quadtree<Rect>(bounds());
    tree.insert(rect(0, 0));
    expect(tree.retrieve(rect(500, 500, 10, 10))).toEqual([]);
  });

  it("maxLevels 到顶后不再分裂（防止极端密度下无限递归）", () => {
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 1, maxLevels: 0 });
    tree.insert(rect(0, 0, 2, 2));
    tree.insert(rect(1, 1, 2, 2));
    expect(tree.nodes).toHaveLength(0);
    expect(tree.items).toHaveLength(2);
  });

  it("clear 递归清空每一层的条目与子树", () => {
    const tree = new Quadtree<Rect>(bounds(), { maxObjects: 1, maxLevels: 4 });
    tree.insert(rect(0, 0, 5, 5));
    tree.insert(rect(6, 6, 5, 5));
    expect(tree.nodes).toHaveLength(4);

    tree.clear();
    expect(tree.items).toHaveLength(0);
    expect(tree.nodes).toHaveLength(0);
    expect(tree.retrieve(bounds())).toEqual([]);
  });
});
