import * as THREE from "three";
import type { SceneDocument } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

export type ExportFormat = "glb" | "obj";

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

function safeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoke on the next macrotask: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Export the document (not the preview) as GLB / OBJ.
 *
 * Objects are cloned with their stored transforms, so an exploded view or an
 * in-flight gizmo drag never leaks into the exported file.
 */
export async function exportDocument(
  runtime: ThreeRuntime,
  doc: SceneDocument,
  format: ExportFormat,
): Promise<string> {
  const group = new THREE.Group();
  group.name = safeName(doc.sceneId, "scene");

  for (const dto of doc.objects) {
    const source = runtime.getObjectById(dto.id);
    if (!source) continue;
    const clone = source.clone(true);
    clone.position.set(dto.position[0], dto.position[1], dto.position[2]);
    clone.rotation.set(dto.rotation[0], dto.rotation[1], dto.rotation[2]);
    clone.scale.set(dto.scale[0], dto.scale[1], dto.scale[2]);
    group.add(clone);
  }

  if (group.children.length === 0) {
    throw new Error("场景为空，没有可导出的对象");
  }

  const filename = `${safeName(doc.sceneId, "scene")}-${stamp()}.${format}`;

  if (format === "glb") {
    const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
    const exported = await new GLTFExporter().parseAsync(group, { binary: true });
    const buffer = exported instanceof ArrayBuffer ? exported : new ArrayBuffer(0);
    download(new Blob([buffer], { type: "model/gltf-binary" }), filename);
    return filename;
  }

  const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
  const text = new OBJExporter().parse(group);
  download(new Blob([text], { type: "text/plain" }), filename);
  return filename;
}

/** Download the current frame as PNG. Returns the file name. */
export function captureSnapshot(
  runtime: ThreeRuntime,
  el: SceneEditorElement,
  doc?: SceneDocument,
): string {
  const canvas = el.querySelector("canvas");
  if (!canvas) throw new Error("视口尚未就绪");

  // Render immediately before reading the buffer: no compositing in between.
  runtime.render();
  const dataUrl = canvas.toDataURL("image/png");
  const base = doc ? safeName(doc.sceneId, "scene") : "scene";
  const filename = `${base}-${stamp()}.png`;

  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
  return filename;
}
