import { SceneEditorElement } from "./scene-editor-element";

/** Explicit registration (no top-level side effects, SSR-safe). Idempotent (D20). */
export function defineSceneEditor(): void {
  if (customElements.get("scene-editor")) return;
  customElements.define("scene-editor", SceneEditorElement);
}
