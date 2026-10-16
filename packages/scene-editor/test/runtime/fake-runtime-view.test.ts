import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../../src/runtime/fake-runtime";
import { createDefaultViewState } from "../../src/core/document/default-view";

describe("FakeRuntime view contract (D22)", () => {
  it("records applied views and returns the last one", () => {
    const runtime = new FakeRuntime();
    const view = createDefaultViewState();
    view.camera.fov = 42;
    runtime.applyViewState(view);
    expect(runtime.calls.applyViewState).toEqual([view]);
    expect(runtime.getViewState()).toEqual(view);
  });

  it("reports the default view before anything is applied", () => {
    expect(new FakeRuntime().getViewState()).toEqual(createDefaultViewState());
  });

  it("does not emit view-change from applyViewState by default", () => {
    const runtime = new FakeRuntime();
    const seen: unknown[] = [];
    runtime.events.on("view-change", (payload) => seen.push(payload));
    runtime.applyViewState(createDefaultViewState());
    expect(seen).toEqual([]);
  });

  it("emits view-change when the helper simulates an interaction", () => {
    const runtime = new FakeRuntime();
    const seen: unknown[] = [];
    runtime.events.on("view-change", (payload) => seen.push(payload));
    const view = createDefaultViewState();
    view.camera.position = [1, 2, 3];
    runtime.simulateViewChange(view);
    expect(seen).toEqual([{ view }]);
  });

  it("returns detached copies (no aliasing)", () => {
    const runtime = new FakeRuntime();
    const view = createDefaultViewState();
    runtime.applyViewState(view);
    view.camera.fov = 99;
    expect(runtime.getViewState().camera.fov).toBe(60);
  });
});
