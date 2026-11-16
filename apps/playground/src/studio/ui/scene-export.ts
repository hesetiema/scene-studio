import { downloadBlob, type SceneEditorElement } from "@scenio/scene-editor/element";

export type ExportFormat = "glb" | "obj";

/**
 * Export the document (not the preview) as GLB / OBJ and save it.
 *
 * Both steps are the SDK's: `exportDocument()` serializes stored transforms (an
 * exploded view or an in-flight gizmo drag never leaks into the file), and
 * `downloadBlob()` names and saves it. What is left here is the studio's own
 * choice of file name.
 */
export async function exportDocument(
  el: SceneEditorElement,
  format: ExportFormat,
): Promise<string> {
  const blob = await el.exportDocument({ format });
  return downloadBlob(blob, `${el.getDocument().sceneId}.${format}`);
}

/** Download the current frame as PNG. Returns the file name. */
export async function captureSnapshot(el: SceneEditorElement): Promise<string> {
  const blob = await el.toBlob("image/png");
  if (!blob) throw new Error("视口尚未就绪");
  return downloadBlob(blob, `${el.getDocument().sceneId}.png`);
}
