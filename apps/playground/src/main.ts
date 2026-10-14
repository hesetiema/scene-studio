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
  ],
};

const el = document.querySelector("scene-editor") as SceneEditorElement;
void el.ready.then(async () => {
  await el.loadDocument(doc);
  el.addEventListener("save-request", () => {
    // playground: log snapshot; real hosts persist here (D18)
    console.log("save-request", el.getDocument());
  });
});
