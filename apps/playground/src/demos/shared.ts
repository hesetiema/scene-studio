/**
 * Shared plumbing for the focused demos under `/demos/*.html`.
 *
 * Each demo page owns exactly one SDK surface (host API, document model,
 * headless facade, assets). This module only holds the boring parts: DOM
 * lookups, a log panel, the fixture document, and transform helpers.
 */
import type { SceneDocument, Transform } from "@scenio/scene-editor";

export function q<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}

export function qa<T extends Element>(selector: string): T[] {
  return [...document.querySelectorAll<T>(selector)];
}

export interface DemoLogger {
  (message: string): void;
  ok(message: string): void;
  err(message: string): void;
}

/** Appends timestamped lines to `#log` (newest first) and mirrors to the console. */
export function createLog(target: Element = q("#log")): DemoLogger {
  const write = (message: string, kind?: "ok" | "err"): void => {
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    if (kind) line.className = kind;
    target.prepend(line);
    while (target.childElementCount > 120) target.lastElementChild?.remove();
  };
  const log = ((message: string) => {
    write(message);
    console.log(`[demo] ${message}`);
  }) as DemoLogger;
  log.ok = (message) => write(message, "ok");
  log.err = (message) => write(message, "err");
  return log;
}

/** Deterministic 3-box scene: enough objects for multi-select and batch demos. */
export const demoDoc: SceneDocument = {
  schemaVersion: 2,
  sceneId: "sdk-demo",
  revision: 0,
  objects: [
    {
      id: "box-1",
      type: "mesh",
      name: "Box A",
      position: [-1.6, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "box-2",
      type: "mesh",
      name: "Box B",
      position: [0, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "box-3",
      type: "mesh",
      name: "Box C",
      position: [1.6, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
  view: {
    camera: { position: [5.5, 4.2, 8.5], target: [0, 0.5, 0], fov: 50 },
    lights: {
      ambient: { color: "#ffffff", intensity: 0.6 },
      directional: { color: "#eef6ff", intensity: 1.2, position: [5, 10, 7] },
    },
    environment: { background: "#0b0f19", gridVisible: true },
  },
};

export function transformOf(doc: SceneDocument, id: string): Transform {
  const object = doc.objects.find((item) => item.id === id);
  if (!object) throw new Error(`object not found: ${id}`);
  return {
    position: object.position,
    rotation: object.rotation,
    scale: object.scale,
  };
}

/** `a, b` / `-` — keeps status lines short and stable for e2e assertions. */
export function selectionText(ids: readonly string[]): string {
  return ids.length ? ids.join(", ") : "-";
}

/**
 * Renders `label=value` pairs using text nodes only.
 *
 * Demo status bars read values that can come from a document (sceneId, object
 * ids, asset ids) — i.e. from host/user data. Never build that with
 * `innerHTML`, or a document can inject markup into the page.
 */
export function setFields(target: Element, fields: Array<[string, unknown]>): void {
  const nodes = fields.flatMap(([label, value], index) => {
    const labelEl = document.createElement("span");
    labelEl.textContent = `${label}=`;
    const valueEl = document.createElement("b");
    valueEl.textContent = String(value);
    const parts: Node[] = [labelEl, valueEl];
    if (index < fields.length - 1) parts.push(document.createTextNode("   "));
    return parts;
  });
  target.replaceChildren(...nodes);
}
