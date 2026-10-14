import { describe, expect, it, vi } from "vitest";
import { CommandHistory } from "../../src/core/history/command-history";
import { TransformCommand } from "../../src/core/commands/transform-command";
import type { Transform } from "../../src/runtime/runtime-contract";

const t0: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
const t1: Transform = {
  position: [1, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

describe("TransformCommand", () => {
  it("applies target on execute and previous on undo", () => {
    let current = t0;
    const apply = vi.fn((_id: string, t: Transform) => {
      current = t;
    });
    const cmd = new TransformCommand("obj-1", t0, t1, apply);
    cmd.execute();
    expect(current).toBe(t1);
    cmd.undo();
    expect(current).toBe(t0);
  });
});

describe("CommandHistory", () => {
  it("executes, undoes and redoes in order", () => {
    const history = new CommandHistory();
    let value = 0;
    const make = (n: number) => ({
      label: `set-${n}`,
      execute: () => {
        value = n;
      },
      undo: () => {
        value = n - 1;
      },
    });
    history.execute(make(1));
    history.execute(make(2));
    expect(value).toBe(2);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    history.undo();
    expect(value).toBe(1);
    expect(history.canRedo).toBe(true);
    history.redo();
    expect(value).toBe(2);
  });

  it("clears redo stack on new execute", () => {
    const history = new CommandHistory();
    const noop = { label: "noop", execute: () => {}, undo: () => {} };
    history.execute(noop);
    history.undo();
    expect(history.canRedo).toBe(true);
    history.execute(noop);
    expect(history.canRedo).toBe(false);
  });

  it("tracks dirty until markClean; clear resets stacks and dirty", () => {
    const history = new CommandHistory();
    const noop = { label: "noop", execute: () => {}, undo: () => {} };
    expect(history.dirty).toBe(false);
    history.execute(noop);
    expect(history.dirty).toBe(true);
    history.markClean();
    expect(history.dirty).toBe(false);
    history.execute(noop);
    history.clear();
    expect(history.canUndo).toBe(false);
    expect(history.dirty).toBe(false);
  });

  it("notifies listener with state after each mutation", () => {
    const onChange = vi.fn();
    const history = new CommandHistory(onChange);
    const noop = { label: "noop", execute: () => {}, undo: () => {} };
    history.execute(noop);
    expect(onChange).toHaveBeenCalledWith({
      canUndo: true,
      canRedo: false,
      dirty: true,
      lastCommand: "noop",
    });
  });
});
