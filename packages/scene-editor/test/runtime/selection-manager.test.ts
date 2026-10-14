import { describe, expect, it, vi } from "vitest";
import { SelectionManager } from "../../src/runtime/selection-manager";
import { EditorController } from "../../src/runtime/editor-controller";
import { FakeRuntime } from "../../src/runtime/fake-runtime";

describe("SelectionManager", () => {
  it("sets, dedupes and reports selection", () => {
    const sel = new SelectionManager();
    sel.set(["a", "b", "a"]);
    expect(sel.ids).toEqual(["a", "b"]);
    expect(sel.isSelected("a")).toBe(true);
    expect(sel.isSelected("z")).toBe(false);
  });

  it("clear empties selection", () => {
    const sel = new SelectionManager();
    sel.set(["a"]);
    sel.clear();
    expect(sel.ids).toEqual([]);
  });

  it("notifies listener on change with a frozen snapshot", () => {
    const onChange = vi.fn();
    const sel = new SelectionManager(onChange);
    sel.set(["x"]);
    expect(onChange).toHaveBeenCalledWith(["x"]);
    expect(Object.isFrozen(onChange.mock.calls[0]?.[0])).toBe(true);
  });

  it("does not notify when ids are unchanged", () => {
    const onChange = vi.fn();
    const sel = new SelectionManager(onChange);
    sel.set(["a"]);
    onChange.mockClear();
    sel.set(["a"]);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("EditorController selection integration", () => {
  it("select forwards to runtime and broadcasts selection-change", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    const seen: string[][] = [];
    fake.events.on("selection-change", (p) => seen.push(p.ids));
    controller.select(["o1", "o2"]);
    expect(fake.calls.select).toEqual([["o1", "o2"]]);
    expect(seen).toEqual([["o1", "o2"]]);
    expect(controller.selectedIds).toEqual(["o1", "o2"]);
  });

  it("clearSelection empties and notifies", () => {
    const fake = new FakeRuntime();
    const controller = new EditorController(fake);
    controller.select(["o1"]);
    const seen: string[][] = [];
    fake.events.on("selection-change", (p) => seen.push(p.ids));
    controller.clearSelection();
    expect(fake.calls.clearSelection).toBe(1);
    expect(seen).toEqual([[]]);
  });
});
