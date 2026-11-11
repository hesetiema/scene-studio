import * as THREE from "three";
import type { SceneDocument } from "../core/document/schema";

/** Formats the document exporter can produce. */
export type DocumentExportFormat = "glb" | "gltf" | "obj";

/** Anything that resolves a document object id to its live root. */
export interface DocumentObjectSource {
  getObjectById(id: string): THREE.Object3D | null | undefined;
}

/**
 * Clone the document into one detached group, with **document** transforms.
 *
 * The live scene graph is not the document: an exploded view, a preview
 * material or an in-flight gizmo drag all live on the runtime objects. Export
 * must not carry those, so every clone gets the stored transform written back —
 * that is the whole difference between "what is on screen" and "what is saved".
 *
 * Geometry and materials are shared with the originals (a `clone()` does that);
 * the group is therefore free to throw away, but nothing in it may be disposed.
 */
export function createDocumentGroup(
  doc: SceneDocument,
  source: DocumentObjectSource,
): THREE.Group {
  const group = new THREE.Group();
  group.name = sanitizeName(doc.sceneId, "scene");

  for (const dto of doc.objects) {
    const root = source.getObjectById(dto.id);
    if (!root) continue;
    const clone = root.clone(true);
    clone.position.set(dto.position[0], dto.position[1], dto.position[2]);
    clone.rotation.set(dto.rotation[0], dto.rotation[1], dto.rotation[2]);
    clone.scale.set(dto.scale[0], dto.scale[1], dto.scale[2]);
    group.add(clone);
  }

  group.updateMatrixWorld(true);
  return group;
}

/** Serialize a group to a Blob. Exporters are loaded on demand. */
export async function exportGroupBlob(
  group: THREE.Group,
  format: DocumentExportFormat,
): Promise<Blob> {
  if (format === "obj") {
    const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
    const text = new OBJExporter().parse(group);
    // Not an IANA type, but it is what makes `downloadBlob()` pick ".obj".
    return new Blob([text], { type: "model/obj" });
  }

  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exported = await new GLTFExporter().parseAsync(group, { binary: format === "glb" });

  if (format === "glb") {
    return new Blob([exported instanceof ArrayBuffer ? exported : new ArrayBuffer(0)], {
      type: "model/gltf-binary",
    });
  }
  return new Blob([typeof exported === "string" ? exported : JSON.stringify(exported)], {
    type: "model/gltf+json",
  });
}

/**
 * Export the **document** (not the viewport) as GLB / glTF / OBJ.
 *
 * Object identity survives: ids, names and hierarchy are the document's, the
 * grid / gizmo / contact plane never lived in the object store, and nothing
 * presentation-only (explode offsets, display modes) is baked in.
 *
 * Limitation, shared with `RuntimeContract.exportScene`: animation clips belong
 * to the asset, not to the document, so an exported file has no animations.
 */
export async function exportDocumentBlob(
  doc: SceneDocument,
  source: DocumentObjectSource,
  format: DocumentExportFormat = "glb",
): Promise<Blob> {
  return exportGroupBlob(createDocumentGroup(doc, source), format);
}

/** `sceneId` → a file-name-safe stem. */
export function sanitizeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}
