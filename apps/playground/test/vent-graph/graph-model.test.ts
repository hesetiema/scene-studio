import { describe, expect, it } from "vitest";
import { GraphModel } from "../../src/vent/graph/graph-model";
import { StateStyleTable } from "../../src/vent/graph/state-styles";

const model = (id: string, kind: "equip" | "space" = "equip"): GraphModel =>
  new GraphModel({ id, kind, world: { x: 0, y: 0, z: 0 } });

describe("GraphModel 默认值", () => {
  it("label 回落 id，weight 为 0，mediaName 回落 kind，icon 默认 fan", () => {
    const m = model("e1");
    expect(m.label).toBe("e1");
    expect(m.detail).toBe("");
    expect(m.weight).toBe(0);
    expect(m.mediaName).toBe("equip");
    expect(m.icon).toBe("fan");
    expect(m.visible).toBe(true);
    expect(m.iconHidden).toBe(false);
    expect(m.textHidden).toBe(false);
  });

  it("构造参数覆盖默认值", () => {
    const m = new GraphModel({
      id: "e1",
      kind: "equip",
      world: { x: 1, y: 2, z: 3 },
      label: "风机 1",
      detail: "运行",
      weight: 7,
      mediaName: "custom",
      icon: "window",
    });
    expect([m.label, m.detail, m.weight, m.mediaName, m.icon]).toEqual(["风机 1", "运行", 7, "custom", "window"]);
  });
});

describe("GraphModel 状态", () => {
  it("setState 增删状态", () => {
    const m = model("e1");
    m.setState("fault");
    expect(m.hasState("fault")).toBe(true);
    m.setState("fault", false);
    expect(m.hasState("fault")).toBe(false);
  });

  it("异步状态走独立命名空间，不会挤掉同名本地状态", () => {
    const m = model("e1").setState("on").setAsyncState("on");
    expect(m.hasState("on")).toBe(true);
    expect(m.hasState("async:on")).toBe(true);
  });

  it("绑定样式表后立即算出 currentStyle，后续状态变化手动重算", () => {
    const table = new StateStyleTable().setStateStyles({ on: { style: { iconColor: "green" } } });
    const m = model("e1").bindStyleTable(table);
    expect(m.currentStyle).toEqual({});

    m.setState("on");
    expect(m.currentStyle).toEqual({});
    expect(m.caclCurrentStyle()).toEqual({ iconColor: "green" });
  });
});

describe("GraphModel 聚合链", () => {
  it("attach / detach 维护双向指针", () => {
    const a = model("a");
    const b = model("b");
    a.attach(b);

    expect(b.absorbTo).toBe(a);
    expect(a.children).toContain(b);
    expect(b.root).toBe(a);

    a.detach(b);
    expect(b.absorbTo).toBeNull();
    expect(a.children).toHaveLength(0);
  });

  it("attach 幂等，且不会把自己挂到自己身上", () => {
    const a = model("a");
    const b = model("b");
    a.attach(b);
    a.attach(b);
    a.attach(a);

    expect(a.children).toHaveLength(1);
    expect(a.absorbTo).toBeNull();
  });

  it("detach 非子节点是安全的空操作", () => {
    const a = model("a");
    const b = model("b");
    expect(() => a.detach(b)).not.toThrow();
    expect(a.children).toHaveLength(0);
  });

  it("root 与 absorbedCount 沿链递归", () => {
    const a = model("a");
    const b = model("b");
    const c = model("c");
    a.attach(b);
    b.attach(c);

    expect(c.root).toBe(a);
    expect(a.absorbedCount).toBe(3);
    expect(b.absorbedCount).toBe(2);
  });

  it("getGroupMembers 返回自身加全部后代", () => {
    const a = model("a");
    const b = model("b");
    const c = model("c");
    a.attach(b);
    b.attach(c);

    expect(a.getGroupMembers().map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });
});
