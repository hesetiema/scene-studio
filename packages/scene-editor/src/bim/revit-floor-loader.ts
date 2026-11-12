/**
 * Revit light-geometry floor loader (one JSON per storey).
 *
 * Source format (produced by the host's extractor from the `dtp-rwd-server`
 * light-weight Revit service):
 *
 * ```jsonc
 * {
 *   "floorId": "Fl…",
 *   "projectId": "Pj…",
 *   "unit": "foot",          // geometry already baked to this unit
 *   "up": "y",               // vertex layout axis convention
 *   "bbox": [minX,minY,minZ,maxX,maxY,maxZ],
 *   "categories": {
 *     "CFCSWL": {            // wall, column, stair, slab, curtain panel, …
 *       "position": "base64 Float32Array(xyz)",
 *       "index": "base64 Uint16Array|Uint32Array",
 *       "indexType": "u16" | "u32"
 *     }
 *   }
 * }
 * ```
 *
 * Each category is already a single merged buffer with all instances baked in
 * world space (transform + unit + Y-up applied offline), so mounting a storey
 * is one `Mesh` per category — no per-instance bookkeeping at runtime.
 *
 * Scope: **structure only**. Which categories to mount, materials, colours,
 * elevation offsets, and visibility are the consumer's decision through
 * `resolveMaterial` / `onMesh`.
 *
 * No document write happens here — the group is presentation-layer content the
 * host adds to a runtime scene.
 */
import * as THREE from "three";

/** Metadata carried by one storey asset. */
export interface RevitFloorMeta {
  floorId: string;
  projectId?: string;
  /** Unit the vertices are baked in (informational; the loader does not scale). */
  unit?: string;
  /** Up axis of the vertex layout (informational). */
  up?: string;
  /** `[minX,minY,minZ,maxX,maxY,maxZ]` of the whole storey. */
  bbox?: [number, number, number, number, number, number];
}

/** One category inside a storey asset. */
export interface RevitCategoryData {
  position: string;
  index: string;
  indexType?: "u16" | "u32";
}

interface RevitFloorJson extends RevitFloorMeta {
  categories: Record<string, RevitCategoryData>;
}

/** Per-category info handed to the hooks. */
export interface RevitCategoryInfo {
  /** Category code, e.g. `CFCSWL` (wall), `CFCSFL` (slab). */
  category: string;
  /** Vertex count of the merged buffer. */
  vertexCount: number;
  /** Triangle count of the merged buffer. */
  triangleCount: number;
  /** Axis-aligned bounds of this category. */
  bbox: THREE.Box3;
}

export interface LoadRevitFloorOptions {
  /** Directory holding `{floorId}.json` (no trailing slash needed). */
  baseUrl: string;
  /** Storey id used as the file name. */
  floorId: string;
  /** Restrict to these categories; default = every category in the file. */
  categories?: string[];
  /**
   * Material per category. Return `null` to skip the category, or `undefined`
   * to fall back to the default (a plain `MeshBasicMaterial`, untextured).
   */
  resolveMaterial?: (info: RevitCategoryInfo) => THREE.Material | null | undefined;
  /** Per-mesh callback for tagging / layering / visibility. */
  onMesh?: (mesh: THREE.Mesh, info: RevitCategoryInfo) => void;
  /** Abort signal for the fetch. */
  signal?: AbortSignal | undefined;
}

export interface RevitFloorHandle extends Omit<RevitFloorMeta, "bbox"> {
  /** Container group; add it to the scene. */
  group: THREE.Group;
  /** Mounted meshes keyed by category code. */
  byCategory: Map<string, THREE.Mesh[]>;
  /** Categories actually mounted, in file order. */
  categories: string[];
  /** Overall bounds (from the asset, or computed when absent). */
  bbox: THREE.Box3;
  /** Free every geometry + material created here and detach the group. */
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* base64 → typed array                                                */
/* ------------------------------------------------------------------ */

function decodeBase64(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toFloat32(input: string): Float32Array {
  const bytes = decodeBase64(input);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function toIndex(input: string, type: "u16" | "u32" | undefined): THREE.BufferAttribute {
  const bytes = decodeBase64(input);
  if (type === "u32") {
    return new THREE.BufferAttribute(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), 1);
  }
  return new THREE.BufferAttribute(new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2), 1);
}

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

function joinUrl(base: string, file: string): string {
  return `${base.replace(/\/+$/, "")}/${file}`;
}

export async function loadRevitFloor(options: LoadRevitFloorOptions): Promise<RevitFloorHandle> {
  const { baseUrl, floorId, categories: only, resolveMaterial, onMesh, signal } = options;
  const url = joinUrl(baseUrl, `${floorId}.json`);
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`loadRevitFloor: ${url} → HTTP ${res.status}`);
  const json = (await res.json()) as RevitFloorJson;

  const group = new THREE.Group();
  group.name = `revit-floor:${floorId}`;
  const byCategory = new Map<string, THREE.Mesh[]>();
  const mounted: string[] = [];
  const disposables: Array<{ dispose(): void }> = [];
  const bbox = new THREE.Box3();

  if (json.bbox) {
    const [x0, y0, z0, x1, y1, z1] = json.bbox;
    bbox.min.set(x0, y0, z0);
    bbox.max.set(x1, y1, z1);
  }

  for (const [category, data] of Object.entries(json.categories)) {
    if (only && !only.includes(category)) continue;

    const geometry = new THREE.BufferGeometry();
    const position = toFloat32(data.position);
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setIndex(toIndex(data.index, data.indexType));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    disposables.push(geometry);

    const catBox = geometry.boundingBox?.clone() ?? new THREE.Box3();
    const info: RevitCategoryInfo = {
      category,
      vertexCount: position.length / 3,
      triangleCount: (geometry.index?.count ?? 0) / 3,
      bbox: catBox,
    };

    const material = resolveMaterial ? resolveMaterial(info) : undefined;
    if (material === null) {
      geometry.dispose();
      disposables.pop();
      continue;
    }
    const mat = material ?? new THREE.MeshBasicMaterial({ color: 0xcccccc });
    if (!material) disposables.push(mat);

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = category;
    mesh.userData["category"] = category;
    onMesh?.(mesh, info);

    group.add(mesh);
    mounted.push(category);
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)!.push(mesh);

    if (!json.bbox) bbox.union(catBox);
  }

  return {
    floorId: json.floorId ?? floorId,
    ...(json.projectId ? { projectId: json.projectId } : {}),
    ...(json.unit ? { unit: json.unit } : {}),
    ...(json.up ? { up: json.up } : {}),
    group,
    byCategory,
    categories: mounted,
    bbox,
    dispose() {
      group.removeFromParent();
      group.clear();
      for (const d of disposables) d.dispose();
    },
  };
}
