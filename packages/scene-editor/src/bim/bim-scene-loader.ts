/**
 * EffectTool-style BIM scene loader (Scene.json + binary FBX + Materials.json).
 *
 * Scope: **structure only**. The loader understands the container format —
 * manifest → FBX chunks → per-storey meshes, render-info visibility, storey
 * grouping — and hands everything visual to the consumer through hooks:
 *
 * - `resolveMaterial` decides materials per mesh (default: keep whatever the
 *   FBX chunk carries — the loader creates no materials of its own).
 * - `onMesh` is a per-mesh callback for tagging, restyling, overlays, …
 * - `resolveFloorKey` overrides the storey-name heuristic when a project uses
 *   its own mesh-naming convention.
 *
 * `Materials.json` is parsed and exposed raw (`handle.materials`) so a consumer
 * can map guid → its own material policy; nothing here interprets colours.
 *
 * Format facts (verified against `05_building_classic`):
 * - `Scene.json` — manifest: FBX chunk list, per-mesh render info (visibility,
 *   material guids), grouped by chunk `gName`.
 * - `Models/{name}.fbx` — standard Kaydara FBX Binary chunks; each child mesh is
 *   named per storey (`1F`, `B3F`, `RF`, …) or decor (`图形001`).
 * - `Materials.json` — `materialModels[]` of `{ GUID, Content }`.
 *
 * No document write happens here — the group is presentation-layer content the
 * host adds to a runtime scene.
 */
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

/* ------------------------------------------------------------------ */
/* Format shapes (only the fields the structure needs)                 */
/* ------------------------------------------------------------------ */

/** Raw `Materials.json` content entry, passed through uninterpreted. */
export interface MaterialContent {
  _Color?: string;
  _Alpha?: number | string;
  _Metallic?: number | string;
  _Roughness?: number | string;
  DoubleSide?: boolean;
  _EmissionColor?: string;
  Name?: string;
}

export interface MaterialModel {
  GUID: string;
  Content: MaterialContent;
}

/** Raw `meshRenderModels[]` entry (`url` = `{chunk}/{meshName}` lowercase). */
export interface MeshRenderModel {
  gName: string;
  url: string;
  visible?: boolean;
  materials?: string[];
}

export interface FbxEntry {
  fbxName: string;
  isMainBuilding?: boolean;
}

interface SceneJson {
  sceneName: string;
  fbxs: FbxEntry[];
  meshRenderModels: MeshRenderModel[];
}

/* ------------------------------------------------------------------ */
/* Hook payloads                                                       */
/* ------------------------------------------------------------------ */

/** Everything the loader knows about one mounted mesh. */
export interface BimMeshInfo {
  /** `{chunk}/{meshName}` lowercased — matches `meshRenderModels.url`. */
  key: string;
  /** Chunk base name (FBX file stem). */
  chunk: string;
  /** Mesh name path within the chunk (`1F`, `B2F`, `图形001/1F`, …). */
  namePath: string;
  /** Storey key (`F1`, `B2`, `RF`, …) or `null` when unmapped. */
  floorKey: string | null;
  /** Raw render-info entry for this mesh, if the manifest lists it. */
  render?: MeshRenderModel | undefined;
  /** First material guid from `render.materials`, if any. */
  materialGuid?: string | undefined;
  /** Raw `Materials.json` content for `materialGuid`, if present. */
  materialContent?: MaterialContent | undefined;
}

export interface LoadBimSceneOptions {
  /** Base URL that serves `{sceneName}/Scene.json` (e.g. `/bim`). */
  baseUrl: string;
  /** Scene folder name, e.g. `05_building_classic`. */
  sceneName: string;
  /** Fetch implementation (defaults to global `fetch`). */
  fetchFn?: typeof fetch;
  /** Load only `isMainBuilding` chunks (default `true`). */
  mainBuildingsOnly?: boolean;
  /** Load the `图形*` wireframe decor chunks (default `true`). */
  includeDecor?: boolean;
  /**
   * Storey key for a mesh. Default: `floorKeyOf(namePath)` with a fallback that
   * pairs `图形*` decor chunks to their sibling solid chunk's storey.
   */
  resolveFloorKey?: (namePath: string, chunk: string) => string | null;
  /**
   * Material policy. Return a `THREE.Material` to assign, or `null`/`undefined`
   * to keep the FBX chunk's own material. The loader never creates materials;
   * anything returned is owned (and disposed) by the consumer.
   */
  resolveMaterial?: (info: BimMeshInfo, mesh: THREE.Mesh) => THREE.Material | null | undefined;
  /** Per-mesh hook after mount — tag `userData`, add overlays, restyle, … */
  onMesh?: (mesh: THREE.Mesh, info: BimMeshInfo) => void;
}

export interface BimSceneHandle {
  /** Root group — add to the runtime scene. */
  readonly group: THREE.Group;
  /** Normalised storey keys present in the model (`F1`, `B2`, `RF`, …). */
  readonly floorKeys: string[];
  /** Meshes per normalised storey key. */
  readonly meshesByFloor: Map<string, THREE.Mesh[]>;
  /** `{chunk}/{meshName}` (lowercased) → mesh, matching `meshRenderModels.url`. */
  readonly meshByName: Map<string, THREE.Mesh>;
  /** Same keys → the structural info handed to hooks. */
  readonly meshInfo: ReadonlyMap<string, BimMeshInfo>;
  /** Raw `Materials.json` guid → content (uninterpreted). */
  readonly materials: ReadonlyMap<string, MaterialContent>;
  /** Show only the given storeys (`null` = all). Unknown/decor meshes hide in filter mode. */
  setFloorsVisible(floorKeys: string[] | null): void;
  /**
   * Dispose loader-owned resources (geometries, the group). Materials supplied
   * via `resolveMaterial` are NOT disposed — the consumer owns them.
   */
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** `1F`→`F1`, `B3F`/`B1FM`→`B3`/`B1`, `RF`/`RFding`→`RF`; anything else → `null`. */
export function floorKeyOf(meshName: string): string | null {
  const n = meshName.trim();
  let m = /^(\d+)F$/i.exec(n);
  if (m) return `F${m[1]}`;
  m = /^B(\d+)FM?$/i.exec(n);
  if (m) return `B${m[1]}`;
  if (/^RF(ding)?$/i.test(n)) return "RF";
  return null;
}

/**
 * Pair `图形*` decor chunks with the storeys of their sibling solid chunk
 * (same `_N` suffix) by position in `meshRenderModels`, so floor filtering can
 * include or hide the wireframe overlay consistently. Best-effort: returns an
 * empty map when the listing does not line up.
 */
function buildDecorFloorMap(meshRenderModels: MeshRenderModel[]): Map<string, string | null> {
  const byChunk = new Map<string, string[]>();
  for (const m of meshRenderModels) {
    const parts = m.url.split("/");
    if (parts.length !== 2) continue;
    const list = byChunk.get(m.gName) ?? [];
    list.push(parts[1]!);
    byChunk.set(m.gName, list);
  }
  const decorMap = new Map<string, string | null>();
  for (const [gName, names] of byChunk) {
    if (!/wireframe/i.test(gName)) continue;
    const suffix = /_(\d+)$/.exec(gName)?.[1];
    if (!suffix) continue;
    const solidName = [...byChunk.keys()].find(
      (k) => /cube/i.test(k) && k.endsWith(`_${suffix}`),
    );
    if (!solidName) continue;
    const solidFloors = byChunk.get(solidName) ?? [];
    names.forEach((decorName, i) => {
      const storey = solidFloors[i];
      decorMap.set(`${gName}/${decorName}`.toLowerCase(), storey ? floorKeyOf(storey) : null);
    });
  }
  return decorMap;
}

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

export async function loadBimScene(options: LoadBimSceneOptions): Promise<BimSceneHandle> {
  const fetchFn = options.fetchFn ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const scenePath = `${base}/${options.sceneName}`;
  const mainOnly = options.mainBuildingsOnly !== false;
  const includeDecor = options.includeDecor !== false;

  const [sceneRes, materialsRes] = await Promise.all([
    fetchFn(`${scenePath}/Scene.json`),
    fetchFn(`${scenePath}/Materials.json`),
  ]);
  if (!sceneRes.ok) throw new Error(`BIM Scene.json fetch failed: ${sceneRes.status}`);
  const sceneJson = (await sceneRes.json()) as SceneJson[] | SceneJson;
  const scene = Array.isArray(sceneJson) ? sceneJson[0] : sceneJson;
  if (!scene?.fbxs?.length) throw new Error("BIM Scene.json has no fbxs");

  const materials = new Map<string, MaterialContent>();
  if (materialsRes.ok) {
    const matJson = (await materialsRes.json()) as { materialModels?: MaterialModel[] };
    for (const m of matJson.materialModels ?? []) {
      materials.set(m.GUID, m.Content);
    }
  }

  const renderInfo = new Map<string, MeshRenderModel>();
  for (const m of scene.meshRenderModels ?? []) {
    renderInfo.set(m.url.toLowerCase(), m);
  }
  const decorFloorMap = buildDecorFloorMap(scene.meshRenderModels ?? []);

  const group = new THREE.Group();
  group.name = `bim:${scene.sceneName}`;
  const meshByName = new Map<string, THREE.Mesh>();
  const meshInfo = new Map<string, BimMeshInfo>();
  const meshesByFloor = new Map<string, THREE.Mesh[]>();
  const geometries: THREE.BufferGeometry[] = [];

  const chunks = scene.fbxs.filter((f) => {
    if (mainOnly && f.isMainBuilding === false) return false;
    if (!includeDecor && /wireframe/i.test(f.fbxName)) return false;
    return true;
  });

  // NOTE: FBXLoader.parse is stateful — never share one instance across
  // concurrent parses (it silently drops meshes). Each chunk gets its own.
  await Promise.all(
    chunks.map(async (entry) => {
      const res = await fetchFn(`${scenePath}/Models/${entry.fbxName}`);
      if (!res.ok) throw new Error(`BIM model fetch failed: ${entry.fbxName} (${res.status})`);
      const buf = await res.arrayBuffer();
      const parsed = new FBXLoader().parse(buf, "");
      const chunkBase = entry.fbxName.replace(/\.fbx$/i, "");

      const mount = (mesh: THREE.Mesh, namePath: string) => {
        const key = `${chunkBase}/${namePath}`.toLowerCase();
        mesh.name = `${chunkBase}/${namePath}`;
        const render = renderInfo.get(key);
        if (render?.visible === false) mesh.visible = false;

        const materialGuid = render?.materials?.[0];
        const info: BimMeshInfo = {
          key,
          chunk: chunkBase,
          namePath,
          floorKey:
            options.resolveFloorKey?.(namePath, chunkBase) ??
            floorKeyOf(namePath) ??
            decorFloorMap.get(key) ??
            null,
          render,
          materialGuid,
          materialContent: materialGuid ? materials.get(materialGuid) : undefined,
        };

        const resolved = options.resolveMaterial?.(info, mesh);
        if (resolved) mesh.material = resolved;
        options.onMesh?.(mesh, info);

        meshByName.set(key, mesh);
        meshInfo.set(key, info);
        if (info.floorKey) {
          const list = meshesByFloor.get(info.floorKey) ?? [];
          list.push(mesh);
          meshesByFloor.set(info.floorKey, list);
        }
        geometries.push(mesh.geometry);
        group.add(mesh);
      };

      // Snapshot children: `group.add(mesh)` detaches from `parsed`, which
      // mutates the live children array mid-iteration and drops every other mesh.
      for (const child of [...parsed.children]) {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh === true && mesh.geometry) {
          mount(mesh, mesh.name || chunkBase);
        } else {
          for (const sub of [...child.children]) {
            const subMesh = sub as THREE.Mesh;
            if (subMesh.isMesh === true && subMesh.geometry) {
              mount(subMesh, `${child.name}/${subMesh.name}`);
            }
          }
        }
      }
      parsed.clear();
    }),
  );

  const handle: BimSceneHandle = {
    group,
    floorKeys: [...meshesByFloor.keys()],
    meshesByFloor,
    meshByName,
    meshInfo,
    materials,
    setFloorsVisible(keys: string[] | null) {
      const filter = keys ? new Set(keys) : null;
      for (const [key, mesh] of meshByName) {
        const info = meshInfo.get(key);
        if (!filter) {
          mesh.visible = info?.render?.visible !== false;
          continue;
        }
        mesh.visible = info?.floorKey !== null && filter.has(info?.floorKey as string);
      }
    },
    dispose() {
      for (const g of geometries) g.dispose();
      group.clear();
    },
  };
  return handle;
}
