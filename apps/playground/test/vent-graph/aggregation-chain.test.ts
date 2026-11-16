import { describe, expect, it } from "vitest";
import { AggregationChain } from "../../src/vent/graph/aggregation-chain";
import { GraphModel } from "../../src/vent/graph/graph-model";

const model = (id: string): GraphModel =>
  new GraphModel({ id, kind: "equip", world: { x: 0, y: 0, z: 0 } });

describe("AggregationChain", () => {
  it("absorb 把被吸收者挂到吸收者的根上", () => {
    const chain = new AggregationChain();
    const a = model("a");
    const b = model("b");

    expect(chain.absorb(a, b)).toBe(true);

    expect(b.absorbTo).toBe(a);
    expect(b.isAbsorbed).toBe(true);
    expect(a.children).toContain(b);
    expect(a.absorbedCount).toBe(2);
    expect(chain.size).toBe(1);
  });

  it("吸收自身或自己的根会被拒绝", () => {
    const chain = new AggregationChain();
    const a = model("a");
    const b = model("b");
    chain.absorb(a, b);

    expect(chain.absorb(a, a)).toBe(false);
    // a 已经是根的成员：反向吸收会造成环
    expect(chain.absorb(b, a)).toBe(false);
    expect(chain.size).toBe(1);
  });

  it("absorb 的目标总是根：已经属于某聚合的模型改挂到新根，原父节点会先摘下", () => {
    const chain = new AggregationChain();
    const a = model("a");
    const b = model("b");
    const c = model("c");
    chain.absorb(a, b);

    chain.absorb(c, b);

    expect(a.children).toHaveLength(0);
    expect(c.children).toContain(b);
    expect(b.absorbTo).toBe(c);
    expect(b.root).toBe(c);
  });

  it("undo 逆序回滚，并把被吸收者还给它原来的父节点", () => {
    const chain = new AggregationChain();
    const a = model("a");
    const b = model("b");
    const c = model("c");
    chain.absorb(a, b);
    chain.absorb(c, b);

    expect(chain.undo()).toBe(true);
    expect(c.children).toHaveLength(0);
    expect(a.children).toContain(b);
    expect(b.absorbTo).toBe(a);
    expect(b.isAbsorbed).toBe(true);

    expect(chain.undo()).toBe(true);
    expect(a.children).toHaveLength(0);
    expect(b.isAbsorbed).toBe(false);
    expect(chain.size).toBe(0);
  });

  it("栈空时 undo 返回 false", () => {
    expect(new AggregationChain().undo()).toBe(false);
  });

  it("clear 回滚全部操作，聚合计数回到 1", () => {
    const chain = new AggregationChain();
    const a = model("a");
    const b = model("b");
    const c = model("c");
    chain.absorb(a, b);
    chain.absorb(a, c);
    expect(a.absorbedCount).toBe(3);

    chain.clear();

    expect(chain.size).toBe(0);
    expect(a.absorbedCount).toBe(1);
    expect([b, c].some((m) => m.isAbsorbed)).toBe(false);
  });
});
