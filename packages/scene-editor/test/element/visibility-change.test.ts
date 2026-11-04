// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SceneEditorElement,
  type VisibilityObserverFactory,
} from "../../src/element/scene-editor-element";
import { defineSceneEditor } from "../../src/element/register";
import { FakeRuntime } from "../../src/runtime/fake-runtime";

const ORIGINAL_RUNTIME_FACTORY = SceneEditorElement.runtimeFactory;
const ORIGINAL_VISIBILITY_FACTORY = SceneEditorElement.visibilityObserverFactory;

let report: ((visible: boolean) => void) | null = null;
let disconnectSpy = vi.fn<() => void>();
let observeSpy = vi.fn<(target: Element) => void>();

function emitVisibility(visible: boolean): void {
  if (!report) throw new Error("visibility observer was not installed");
  report(visible);
}

function installFakeObserver(factory?: VisibilityObserverFactory): void {
  report = null;
  disconnectSpy.mockClear();
  observeSpy.mockClear();
  SceneEditorElement.visibilityObserverFactory =
    factory ??
    ((onChange) => {
      report = onChange;
      return {
        observe: (target: Element): void => {
          observeSpy(target);
        },
        disconnect: (): void => {
          disconnectSpy();
        },
      };
    });
}

async function connect(): Promise<SceneEditorElement> {
  const el = document.createElement("scene-editor") as SceneEditorElement;
  document.body.appendChild(el);
  await el.ready;
  return el;
}

beforeAll(() => {
  defineSceneEditor();
});

beforeEach(() => {
  document.body.innerHTML = "";
  SceneEditorElement.runtimeFactory = () => new FakeRuntime();
  installFakeObserver();
});

afterEach(() => {
  SceneEditorElement.runtimeFactory = ORIGINAL_RUNTIME_FACTORY;
  SceneEditorElement.visibilityObserverFactory = ORIGINAL_VISIBILITY_FACTORY;
});

describe("visibility-change (element-only contract)", () => {
  it("observes the element and reports a crossing", async () => {
    const el = document.createElement("scene-editor") as SceneEditorElement;
    const spy = vi.fn();
    el.addEventListener("visibility-change", spy);
    document.body.appendChild(el);
    await el.ready;

    expect(observeSpy).toHaveBeenCalledWith(el);
    expect(el.visible).toBe(false);

    emitVisibility(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { visible: true } }),
    );
    expect(el.visible).toBe(true);
  });

  it("does not repeat an unchanged value", async () => {
    const el = await connect();
    const spy = vi.fn();
    el.addEventListener("visibility-change", spy);

    emitVisibility(true);
    emitVisibility(true);
    expect(spy).toHaveBeenCalledTimes(1);

    emitVisibility(false);
    emitVisibility(false);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(el.visible).toBe(false);
  });

  it("disconnects the observer and resets visible on removal", async () => {
    const el = await connect();
    emitVisibility(true);
    el.remove();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(el.visible).toBe(false);
  });

  it("stays silent when the platform/factory has no observer", async () => {
    installFakeObserver(() => null);
    const el = await connect();
    const spy = vi.fn();
    el.addEventListener("visibility-change", spy);

    expect(el.visible).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(disconnectSpy).not.toHaveBeenCalled();
  });
});
