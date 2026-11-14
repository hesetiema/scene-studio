import * as THREE from "three";

/**
 * Content fingerprints: what makes two meshes "the same thing drawn twice".
 *
 * A batch is keyed by *content*, not by instance: two boxes created separately
 * share nothing but their parameters, so the key is derived from
 * `geometry.parameters` + a field-by-field material fingerprint. Anything this
 * module cannot fingerprint exactly (procedural geometry without `parameters`,
 * array- or record-valued material fields, transparency) is simply **not
 * batched** — a missed optimisation, never a wrong pixel.
 */

/**
 * Material fields that are identity or bookkeeping, never surface appearance.
 * `version` is excluded on purpose: it bumps on every mutation, so including it
 * would put a just-edited material in a batch of its own forever.
 */
const IGNORED_MATERIAL_KEYS: ReadonlySet<string> = new Set([
  "uuid",
  "id",
  "name",
  "type",
  "version",
  "userData",
  "onBeforeCompile",
  "customProgramCacheKey",
  "onBeforeRender",
  "onAfterRender",
]);

/**
 * Layer the batched proxies are moved to. The main camera renders layer 0 only,
 * so a proxy stops drawing — while staying `visible`, which is what keeps
 * vertex framing (`traverseVisible`), GLB export and host traversal working
 * unchanged. Anything that raycasts has to opt into this layer
 * (`raycaster.layers.enableAll()`, which is what `picker.ts` does).
 */
export const BATCH_PROXY_LAYER = 1;

/**
 * Content key for a material, or `null` when it cannot be fingerprinted with
 * certainty.
 *
 * Conservative by design: only primitives, `Color`s, textures and vectors are
 * understood. An array or a record (clipping planes, `defines`, a custom
 * uniform bag) can change the program in ways this key cannot see, so the
 * material is refused instead of risked.
 */
export function materialKey(material: THREE.Material): string | null {
  const parts: string[] = [material.type];
  const record = material as unknown as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (IGNORED_MATERIAL_KEYS.has(key)) continue;
    const value = record[key];

    if (value === null || value === undefined) {
      parts.push(`${key}=`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      parts.push(`${key}=${String(value)}`);
      continue;
    }
    if (typeof value === "object") {
      const candidate = value as {
        isColor?: boolean;
        isTexture?: boolean;
        isVector2?: boolean;
        isVector3?: boolean;
        isVector4?: boolean;
        isEuler?: boolean;
        getHexString?: () => string;
        toArray?: () => number[];
        uuid?: string;
      };
      if (candidate.isColor === true && candidate.getHexString) {
        parts.push(`${key}=#${candidate.getHexString()}`);
        continue;
      }
      if (candidate.isTexture === true) {
        parts.push(`${key}=tex:${candidate.uuid ?? ""}`);
        continue;
      }
      if (
        (candidate.isVector2 === true ||
          candidate.isVector3 === true ||
          candidate.isVector4 === true ||
          candidate.isEuler === true) &&
        candidate.toArray
      ) {
        parts.push(`${key}=${candidate.toArray().join(",")}`);
        continue;
      }
      // `defines` is a plain record of shader constants (`{ STANDARD: "" }` on
      // every stock material). Sorted so key order cannot fake a difference.
      if (key === "defines") {
        const entries = Object.entries(value as Record<string, unknown>);
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const rendered = entries.map(([name, entry]) => `${name}:${String(entry)}`).join(",");
        parts.push(`${key}={${rendered}}`);
        continue;
      }
      return null;
    }
    // Functions: `Material` keeps a couple of callbacks we did not list.
    if (key === "onShaderError") continue;
    return null;
  }

  return parts.join("|");
}

/**
 * Content key for a geometry, or `null` when it has no declarative parameters.
 *
 * Every stock three primitive (`BoxGeometry`, `SphereGeometry`, …) records what
 * it was built from, so two objects built from the same document geometry get
 * the same key. A `BufferGeometry` that came out of a glTF has no parameters
 * and therefore is never merged with anything.
 */
export function geometryKey(geometry: THREE.BufferGeometry): string | null {
  const parameters = (geometry as unknown as { parameters?: unknown }).parameters;
  if (!parameters || typeof parameters !== "object") return null;
  try {
    return `${geometry.type}|${JSON.stringify(parameters)}`;
  } catch {
    // Cyclic parameters: give up rather than throw during a load.
    return null;
  }
}

/** Structural gate: a mesh that draws exactly one thing with one material. */
export function affordable(object: THREE.Object3D): object is THREE.Mesh {
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh !== true) return false;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh === true) return false;
  // A subtree (glTF scene root, articulated model) cannot be one instance.
  if (mesh.children.length > 0) return false;
  if (!mesh.geometry) return false;
  if (Array.isArray(mesh.material)) return false;
  const material = mesh.material as THREE.Material | undefined;
  if (!material) return false;
  // One instanced call has one draw order: per-instance alpha sorting is gone.
  if (material.transparent === true) return false;
  if (material.opacity !== undefined && material.opacity < 1) return false;
  // Only default-layer objects are eligible, so releasing one can restore the
  // default mask instead of guessing what the host had.
  if (mesh.layers.mask !== 1) return false;
  return true;
}

/**
 * The batch key for an eligible mesh: geometry key + material key, or `null`
 * when either side refuses to be fingerprinted.
 */
export function contentKey(mesh: THREE.Mesh): string | null {
  const geometry = geometryKey(mesh.geometry);
  if (geometry === null) return null;
  const material = mesh.material as THREE.Material | undefined;
  if (Array.isArray(material) || !material) return null;
  const material_ = materialKey(material);
  return material_ === null ? null : `${geometry}||${material_}`;
}
