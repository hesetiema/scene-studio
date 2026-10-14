import { defineSceneEditor, SceneEditorElement } from "@your-scope/scene-editor/element";
import type { SceneDocument } from "@your-scope/scene-editor";

defineSceneEditor();

const doc: SceneDocument = {
  schemaVersion: 1,
  sceneId: "playground",
  revision: 0,
  objects: [
    {
      id: "box-1",
      type: "mesh",
      name: "Box",
      position: [0, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    {
      id: "box-2",
      type: "mesh",
      name: "Box2",
      position: [2, 0.5, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
  ],
};

/** In-memory host store for e2e save/conflict flows (D18/D17). */
const host = {
  serverDoc: structuredClone(doc),
  /** Force next save to 409 (simulate concurrent edit). */
  forceConflict: false,
  saves: 0,
};

const el = document.querySelector("scene-editor") as SceneEditorElement;

// test hooks
declare global {
  interface Window {
    __editor: SceneEditorElement;
    __host: typeof host;
    __savedDocs: SceneDocument[];
    __conflicts: unknown[];
  }
}
window.__editor = el;
window.__host = host;
window.__savedDocs = [];
window.__conflicts = [];

el.addEventListener("save-request", async () => {
  const local = el.getDocument();
  if (host.forceConflict) {
    // another writer bumped revision — server rejects with structured conflict
    const incoming: SceneDocument = { ...host.serverDoc, revision: host.serverDoc.revision + 1 };
    const conflict = { base: { ...host.serverDoc }, incoming, local };
    window.__conflicts.push(conflict);
    el.dispatchEvent(
      new CustomEvent("save-conflict", { detail: conflict }),
    );
    host.forceConflict = false;
    return;
  }
  if (local.revision !== host.serverDoc.revision) {
    const incoming = host.serverDoc;
    const conflict = { base: { ...host.serverDoc, revision: local.revision }, incoming, local };
    window.__conflicts.push(conflict);
    el.dispatchEvent(new CustomEvent("save-conflict", { detail: conflict }));
    return;
  }
  host.saves += 1;
  const next: SceneDocument = { ...local, revision: local.revision + 1 };
  host.serverDoc = structuredClone(next);
  window.__savedDocs.push(structuredClone(next));
  el.markSaved(next.revision);
});

el.addEventListener("save-conflict", () => {
  // host-driven recovery reference: keep local, show status; no auto-merge (D17)
  document.body.dataset.conflict = "true";
});

document.body.dataset.boot = "pending";
void el.ready.then(async () => {
  await el.loadDocument(doc);

  // URL-driven visual states for deterministic screenshot regression.
  // e.g. /?select=box-1  /?select=box-1&move=1,0.5,0&rot=0,0.8,0&scale=1.2,1.2,1.2
  const params = new URLSearchParams(location.search);
  const selectId = params.get("select");
  if (selectId) {
    el.selectObject(selectId);
  }
  const move = params.get("move");
  const rot = params.get("rot");
  const scale = params.get("scale");
  if (selectId && (move || rot || scale)) {
    const from = el.getDocument().objects.find((o) => o.id === selectId);
    if (from) {
      const parseVec = (s: string | null, fallback: [number, number, number]): [number, number, number] =>
        s ? (s.split(",").map(Number) as [number, number, number]) : fallback;
      el.applyTransform(
        selectId,
        { position: from.position, rotation: from.rotation, scale: from.scale },
        {
          position: parseVec(move, from.position as [number, number, number]),
          rotation: parseVec(rot, from.rotation as [number, number, number]),
          scale: parseVec(scale, from.scale as [number, number, number]),
        },
      );
    }
  }

  // Wait for gizmo (TransformControls) so selection screenshots include it.
  await el.controlsReady;

  // Let rAF settle so WebGL has painted the final frame before screenshots.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  document.body.dataset.boot = "ready";
});
