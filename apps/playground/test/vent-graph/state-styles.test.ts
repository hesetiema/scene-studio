import { describe, expect, it } from "vitest";
import { StateStyleTable } from "../../src/vent/graph/state-styles";

describe("StateStyleTable", () => {
  it("完整形式与简写形式归一成同一份 priority + style", () => {
    const table = new StateStyleTable().setStateStyles({
      on: { priority: 10, style: { iconColor: "#2FBF71" } },
      off: { iconColor: "#8B949E" },
    });

    expect(table.config.on).toEqual({ priority: 10, style: { iconColor: "#2FBF71" } });
    expect(table.config.off).toEqual({ priority: 0, style: { iconColor: "#8B949E" } });
  });

  it("priority 升序合并，后者覆盖前者", () => {
    const table = new StateStyleTable().setStateStyles({
      base: { style: { iconColor: "gray", opacity: 1 } },
      fault: { priority: 100, style: { iconColor: "red" } },
    });

    expect(table.caclCurrentStyle(["fault", "base"])).toEqual({ iconColor: "red", opacity: 1 });
  });

  it("同 priority 时由传入顺序决定胜出者（配置书写顺序不参与）", () => {
    const table = new StateStyleTable().setStateStyles({
      a: { style: { color: "red" } },
      b: { style: { color: "blue" } },
    });

    expect(table.caclCurrentStyle(["a", "b"]).color).toBe("blue");
    expect(table.caclCurrentStyle(["b", "a"]).color).toBe("red");
  });

  it("重复的状态名只计一次", () => {
    const table = new StateStyleTable().setStateStyles({ on: { style: { opacity: 0.5 } } });
    expect(table.caclCurrentStyle(["on", "on", "on"])).toEqual({ opacity: 0.5 });
  });

  it("未注册的状态被忽略，返回空样式", () => {
    const table = new StateStyleTable().setStateStyles({ on: { style: { opacity: 1 } } });
    expect(table.caclCurrentStyle(["missing"])).toEqual({});
  });

  it("setStateStyles 是整表替换：旧的键不再生效", () => {
    const table = new StateStyleTable().setStateStyles({ on: { style: { color: "red" } } });
    table.setStateStyles({ off: { style: { color: "blue" } } });

    expect(Object.keys(table.config)).toEqual(["off"]);
    expect(table.caclCurrentStyle(["on"])).toEqual({});
  });

  it("内部持有副本，外部后续改动不会污染已设置的样式", () => {
    const config = { on: { style: { color: "red" } } };
    const table = new StateStyleTable().setStateStyles(config);
    config.on.style.color = "blue";

    expect(table.caclCurrentStyle(["on"]).color).toBe("red");
  });

  it("calculateCurrentStyle 是 caclCurrentStyle 的拼写别名", () => {
    const table = new StateStyleTable().setStateStyles({ on: { style: { color: "red" } } });
    expect(table.calculateCurrentStyle(["on"])).toEqual(table.caclCurrentStyle(["on"]));
  });
});
