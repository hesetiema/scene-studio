import { describe, expect, it, vi } from "vitest";
import { DisposerStack } from "../../src/runtime/disposer-stack";

describe("DisposerStack", () => {
  it("runs disposers in LIFO order on flush", () => {
    const order: string[] = [];
    const stack = new DisposerStack();
    stack.add(() => order.push("first"));
    stack.add(() => order.push("second"));
    stack.flush();
    expect(order).toEqual(["second", "first"]);
    expect(stack.size).toBe(0);
  });

  it("flush is idempotent (second flush is a no-op)", () => {
    const fn = vi.fn();
    const stack = new DisposerStack();
    stack.add(fn);
    stack.flush();
    stack.flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs all disposers even when some throw, then surfaces errors", () => {
    const ok = vi.fn();
    const stack = new DisposerStack();
    stack.add(ok);
    stack.add(() => {
      throw new Error("boom");
    });
    expect(() => stack.flush()).toThrow("boom");
    expect(ok).toHaveBeenCalledTimes(1);
    expect(stack.size).toBe(0);
  });

  it("allows re-registration after flush (reconnect scenario)", () => {
    const fn = vi.fn();
    const stack = new DisposerStack();
    stack.add(fn);
    stack.flush();
    stack.add(fn);
    expect(stack.size).toBe(1);
    stack.flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
