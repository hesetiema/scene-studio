import { describe, expect, it } from "vitest";
import { CommandHistory, type Command } from "../../src/core/history/command-history";

function cmd(label: string): Command {
  const log: string[] = [];
  return {
    label,
    execute: () => log.push(`+${label}`),
    undo: () => log.push(`-${label}`),
  };
}

describe("CommandHistory clean pointer", () => {
  it("dirty is false after clear; true after execute", () => {
    const h = new CommandHistory();
    expect(h.dirty).toBe(false);
    h.execute(cmd("a"));
    expect(h.dirty).toBe(true);
  });

  it("undo back to clean point clears dirty", () => {
    const h = new CommandHistory();
    h.execute(cmd("a"));
    expect(h.dirty).toBe(true);
    h.undo();
    expect(h.dirty).toBe(false);
  });

  it("undo past clean point (after save mid-stack) stays dirty", () => {
    const h = new CommandHistory();
    h.execute(cmd("a"));
    h.execute(cmd("b"));
    h.markClean(); // save after b
    expect(h.dirty).toBe(false);
    h.undo(); // back to a — still differs from saved
    expect(h.dirty).toBe(true);
    h.redo(); // back to b — matches saved again
    expect(h.dirty).toBe(false);
  });

  it("execute after undo clears redo and dirty relative to clean pointer", () => {
    const h = new CommandHistory();
    h.execute(cmd("a"));
    h.markClean();
    h.undo();
    expect(h.dirty).toBe(true);
    h.execute(cmd("c")); // replaces redo of a
    expect(h.canRedo).toBe(false);
    expect(h.dirty).toBe(true);
  });

  it("markClean after new edits re-anchors clean pointer", () => {
    const h = new CommandHistory();
    h.execute(cmd("a"));
    h.markClean();
    h.execute(cmd("b"));
    expect(h.dirty).toBe(true);
    h.markClean();
    h.undo();
    expect(h.dirty).toBe(true);
  });
});
