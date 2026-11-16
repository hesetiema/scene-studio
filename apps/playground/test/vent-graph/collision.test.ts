import { describe, expect, it } from "vitest";
import { AggregationChain } from "../../src/vent/graph/aggregation-chain";
import { resolveCollisions } from "../../src/vent/graph/collision";
import { GraphModel } from "../../src/vent/graph/graph-model";
import type { ModelKind, Rect } from "../../src/vent/graph/types";

/**
 * 与 GraphScene 一致：边界在视口外各扩 80px。这个外扩不是可有可无的——
 * 四叉树对完全落在 bounds 外的查询直接返回空，向上避让的文字一旦出界，
 * 冲突就会被算成 0。
 */
const BOUNDS: Rect = { x: -200, y: -200, w: 2400, h: 2400 };

/** 设备图标 24×24、设备名 60×21、空间两行文字 100×38——与 GraphScene 的默认估算同尺。 */
const ICON = (x: number, y: number): Rect => ({ x, y, w: 24, h: 24 });
const EQUIP_TEXT = (x: number, y: number): Rect => ({ x, y, w: 60, h: 21 });
const SPACE_TEXT = (x: number, y: number): Rect => ({ x, y, w: 100, h: 38 });

interface Spec {
  id: string;
  kind: ModelKind;
  weight?: number;
  icon?: Rect;
  text?: Rect;
  visible?: boolean;
}

function make(spec: Spec): GraphModel {
  const model = new GraphModel({
    id: spec.id,
    kind: spec.kind,
    world: { x: 0, y: 0, z: 0 },
    weight: spec.weight ?? 0,
  });
  model.iconRect = spec.icon ?? null;
  model.textRect = spec.text ?? null;
  if (spec.visible === false) model.visible = false;
  return model;
}

function run(models: GraphModel[], chain = new AggregationChain()): AggregationChain {
  resolveCollisions(models, chain, { bounds: BOUNDS });
  return chain;
}

describe("图元之间：聚合", () => {
  it("图标重叠时高权重吸收低权重，被吸收者整体隐藏", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 0), text: EQUIP_TEXT(0, 30) });
    const b = make({ id: "b", kind: "equip", weight: 0, icon: ICON(4, 4), text: EQUIP_TEXT(4, 34) });

    const chain = run([a, b]);

    expect(chain.size).toBe(1);
    expect(b.isAbsorbed).toBe(true);
    expect(b.absorbTo).toBe(a);
    expect(b.iconHidden).toBe(true);
    expect(b.textHidden).toBe(true);
    expect(a.iconHidden).toBe(false);
    expect(a.absorbedCount).toBe(2);
  });

  it("胜负只看权重，不看模型在数组里的先后", () => {
    const low = make({ id: "low", kind: "equip", weight: 0, icon: ICON(4, 4) });
    const high = make({ id: "high", kind: "equip", weight: 10, icon: ICON(0, 0) });

    run([low, high]);

    expect(low.isAbsorbed).toBe(true);
    expect(high.absorbedCount).toBe(2);
  });

  it("权重相同时先出现者胜（排序稳定）", () => {
    const first = make({ id: "first", kind: "equip", weight: 5, icon: ICON(0, 0) });
    const second = make({ id: "second", kind: "equip", weight: 5, icon: ICON(2, 2) });

    run([first, second]);

    expect(second.isAbsorbed).toBe(true);
    expect(first.absorbedCount).toBe(2);
  });

  it("一次吸收不阻断同一吸收者对下一个目标的吸收", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 0) });
    const b = make({ id: "b", kind: "equip", weight: 5, icon: ICON(1, 1) });
    const c = make({ id: "c", kind: "equip", weight: 1, icon: ICON(2, 2) });

    const chain = run([a, b, c]);

    expect(chain.size).toBe(2);
    expect(a.absorbedCount).toBe(3);
  });

  it("已被吸收的模型不会再吸收别人", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 0) });
    const b = make({ id: "b", kind: "equip", weight: 5, icon: ICON(1, 1) });
    const c = make({ id: "c", kind: "equip", weight: 1, icon: ICON(2, 2) });

    run([a, b, c]);

    expect(b.isAbsorbed).toBe(true);
    expect(b.children).toHaveLength(0);
  });
});

describe("图元之间：文字避让", () => {
  it("图标压住别人的文字时，牺牲文字、保住图标", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 0) });
    const b = make({ id: "b", kind: "equip", weight: 0, text: EQUIP_TEXT(0, 0) });

    const chain = run([a, b]);

    expect(b.textHidden).toBe(true);
    expect(b.iconHidden).toBe(false);
    expect(chain.size).toBe(0);
  });

  it("两条设备文字相撞时低权重者隐藏，两个图标都还在", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 300), text: EQUIP_TEXT(0, 0) });
    const b = make({ id: "b", kind: "equip", weight: 0, icon: ICON(0, 600), text: EQUIP_TEXT(10, 0) });

    run([a, b]);

    expect(b.textHidden).toBe(true);
    expect(a.textHidden).toBe(false);
    expect(a.iconHidden).toBe(false);
    expect(b.iconHidden).toBe(false);
  });

  it("空间文字之间按权重让位，被隐藏者的 textRect 被清空以免继续参与判定", () => {
    const high = make({ id: "high", kind: "space", weight: 50, text: SPACE_TEXT(0, 0) });
    const low = make({ id: "low", kind: "space", weight: 0, text: SPACE_TEXT(10, 10) });

    run([high, low]);

    expect(low.textHidden).toBe(true);
    expect(low.textRect).toBeNull();
    expect(high.textHidden).toBe(false);
  });

  it("每帧重置隐藏标记：第二轮不会因为上一轮的结论而漏判", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 0) });
    const b = make({ id: "b", kind: "equip", weight: 0, icon: ICON(4, 4) });
    const chain = new AggregationChain();

    run([a, b], chain);
    expect(b.isAbsorbed).toBe(true);
    run([a, b], chain);

    // 链在每帧开头回滚，因此两轮之后仍然是 1 条，而不是 2 条
    expect(chain.size).toBe(1);
    expect(a.absorbedCount).toBe(2);
  });

  it("visible=false 的模型即使带着矩形也不参与", () => {
    const offscreen = make({ id: "off", kind: "equip", icon: ICON(0, 0), text: EQUIP_TEXT(0, 0), visible: false });
    const onscreen = make({ id: "on", kind: "equip", icon: ICON(0, 0) });

    run([offscreen, onscreen]);

    expect(offscreen.isAbsorbed).toBe(false);
    expect(onscreen.absorbedCount).toBe(1);
  });

  it("互不相交时没有任何隐藏或聚合", () => {
    const a = make({ id: "a", kind: "equip", weight: 10, icon: ICON(0, 0), text: EQUIP_TEXT(0, 30) });
    const b = make({ id: "b", kind: "equip", weight: 0, icon: ICON(500, 500), text: EQUIP_TEXT(500, 530) });
    const c = make({ id: "c", kind: "space", weight: 50, text: SPACE_TEXT(1000, 1000) });

    const chain = run([a, b, c]);

    expect(chain.size).toBe(0);
    expect([a, b, c].some((m) => m.iconHidden || m.textHidden)).toBe(false);
  });
});

/**
 * 空间文字是平面的背景信息，设备是前景的可点对象。图标 z 序更高，压在房间名上
 * 会挡字；但直接隐藏太贵——实测 B1 平面图 14 个房间里有 8 个被图标压住，全藏掉
 * 会丢掉大半房间名。所以图标压字时挪一行，文字互相压住时才按权重让位。
 */
describe("图元之间：空间文字与设备同场竞争", () => {
  it("图标压在文字块下缘时，空间文字上移一行让开，而不是隐藏", () => {
    const space = make({ id: "s", kind: "space", weight: 50, text: SPACE_TEXT(0, 100) });
    const equip = make({ id: "e", kind: "equip", weight: 2, icon: ICON(30, 120) });

    run([space, equip]);

    expect(space.textHidden).toBe(false);
    expect(space.textOffsetY).toBe(-20);
    expect(space.textRect?.y).toBe(80);
    expect(equip.iconHidden).toBe(false);
    expect(equip.isAbsorbed).toBe(false);
  });

  it("图标压在文字块上缘时改为下移——避让方向由冲突位置决定", () => {
    const space = make({ id: "s", kind: "space", weight: 50, text: SPACE_TEXT(0, 100) });
    const equip = make({ id: "e", kind: "equip", weight: 2, icon: ICON(30, 85) });

    run([space, equip]);

    expect(space.textHidden).toBe(false);
    expect(space.textOffsetY).toBe(20);
    expect(space.textRect?.y).toBe(120);
  });

  it("没有冲突时保持原位（偏移量为 0，不引入无谓跳动）", () => {
    const space = make({ id: "s", kind: "space", weight: 50, text: SPACE_TEXT(0, 100) });
    const equip = make({ id: "e", kind: "equip", weight: 2, icon: ICON(500, 500) });

    run([space, equip]);

    expect(space.textOffsetY).toBe(0);
    expect(space.textRect?.y).toBe(100);
  });

  it("有读数的空间（weight 50）压过运行中的设备名（weight 2）", () => {
    const space = make({ id: "s", kind: "space", weight: 50, text: SPACE_TEXT(0, 0) });
    // 设备名大到把所有候选位置都盖住，避让无解，才会走到权重判定
    const equip = make({ id: "e", kind: "equip", weight: 2, icon: ICON(500, 500), text: { x: 0, y: -60, w: 100, h: 140 } });

    run([space, equip]);

    expect(equip.textHidden).toBe(true);
    expect(space.textHidden).toBe(false);
  });

  it("故障设备（weight 100）压过空间文字", () => {
    const space = make({ id: "s", kind: "space", weight: 50, text: SPACE_TEXT(0, 0) });
    const equip = make({ id: "e", kind: "equip", weight: 100, icon: ICON(500, 500), text: { x: 0, y: -60, w: 100, h: 140 } });

    run([space, equip]);

    expect(space.textHidden).toBe(true);
    expect(equip.textHidden).toBe(false);
  });

  it("权重相同时设备名优先——房间名是背景，设备名是主体", () => {
    const space = make({ id: "s", kind: "space", weight: 0, text: SPACE_TEXT(0, 0) });
    const equip = make({ id: "e", kind: "equip", weight: 0, icon: ICON(500, 500), text: { x: 0, y: -60, w: 100, h: 140 } });

    run([space, equip]);

    expect(equip.textHidden).toBe(false);
    expect(space.textHidden).toBe(true);
  });

  /**
   * 已定位置的房间名是硬约束，不进代价求和。这里低权重房间名原位（60..100）与盖住
   * 它的设备名（55..155）相交 8000px²，而上移 20px 只与设备名相交 5000px²、与上方
   * 房间名（0..50）相交 2000px²。若把房间名并进代价，求解器会选上移——用「压住
   * 隔壁房间名」换「少压设备名」，换来的是两块字糊在一起。
   */
  it("避让不会把房间名挪到已定位置的房间名头上（软代价换不来这个约束）", () => {
    const above = make({ id: "above", kind: "space", weight: 50, text: { x: 0, y: 0, w: 200, h: 50 } });
    const space = make({ id: "s", kind: "space", weight: 10, text: { x: 0, y: 60, w: 200, h: 40 } });
    const equip = make({ id: "e", kind: "equip", weight: 2, text: { x: 0, y: 55, w: 200, h: 100 } });

    run([above, space, equip]);

    expect(space.textHidden).toBe(false);
    expect(space.textOffsetY).toBe(0);
    expect(space.textRect?.y).toBe(60);
    // 代价是设备名退让，而不是把房间名叠到另一个房间名上
    expect(equip.textHidden).toBe(true);
  });

  it("所有候选位置都被已定房间名占住时退回原位，交给权重判决", () => {
    const above = make({ id: "above", kind: "space", weight: 50, text: { x: 0, y: 0, w: 200, h: 400 } });
    const space = make({ id: "s", kind: "space", weight: 10, text: { x: 0, y: 100, w: 200, h: 40 } });

    run([above, space]);

    expect(space.textOffsetY).toBe(0);
    expect(space.textHidden).toBe(true);
    expect(space.textRect).toBeNull();
  });
});
