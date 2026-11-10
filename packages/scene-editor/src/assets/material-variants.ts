import type * as THREE from "three";

/**
 * `KHR_materials_variants` support (model-viewer's `variant-name`).
 *
 * three r186 does not implement the extension — it survives only as
 * `*_materials_variants` leftovers in `userData`, with no way to switch. So we
 * read it straight off the glTF JSON and resolve the materials through the
 * parser's own dependency cache, which keeps texture and buffer sharing intact.
 *
 * The switch is a material-slot swap per primitive: the extension maps
 * (mesh, primitive) pairs to alternative materials, nothing more.
 */

/**
 * `userData` key holding a primitive's identity across clones. `Object3D.clone`
 * deep-copies `userData` over JSON, so a plain string survives — a material
 * reference would not, which is why the tables live here keyed by it.
 */
export const MATERIAL_VARIANT_KEY = "sceneEditorVariantPrimitive";

/** One primitive's alternatives, plus what it shipped with. */
export interface VariantTable {
  /** The asset's own material, restored when the variant is cleared. */
  base: THREE.Material;
  /** Variant name → material declared for that variant. */
  byName: ReadonlyMap<string, THREE.Material>;
}

export interface MaterialVariantSet {
  /** Declared names, in glTF order (model-viewer's `availableVariants`). */
  names: readonly string[];
  /** Keyed by `mesh.userData[MATERIAL_VARIANT_KEY]`. */
  tables: ReadonlyMap<string, VariantTable>;
}

interface VariantExtension {
  variants?: Array<{ name?: unknown }>;
}

interface PrimitiveExtension {
  mappings?: Array<{ material?: unknown; variants?: unknown }>;
}

interface GltfPrimitiveDef {
  extensions?: Record<string, PrimitiveExtension | undefined>;
}

interface GltfParserLike {
  json?: {
    extensions?: Record<string, VariantExtension | undefined>;
    meshes?: Array<{ primitives?: GltfPrimitiveDef[] }>;
  };
  associations?: Map<unknown, { meshes?: number; primitives?: number }>;
  getDependency?: (type: string, index: number) => Promise<unknown>;
}

interface GltfResultLike {
  scene?: unknown;
  parser?: GltfParserLike;
}

/** `${meshIndex}:${primitiveIndex}` — the identity `associations` gives us. */
function primitiveKey(meshIndex: number, primitiveIndex: number): string {
  return `${meshIndex}:${primitiveIndex}`;
}

function isMaterial(value: unknown): value is THREE.Material {
  return typeof value === "object" && value !== null && (value as THREE.Material).isMaterial === true;
}

/**
 * Collect the variant set for a freshly loaded glTF, or `undefined` when the
 * asset declares none.
 *
 * Never throws: a broken mapping costs that primitive's variants, not the load.
 * Materials that fail to resolve are skipped for the same reason — a document
 * should still render in its default look.
 */
export async function collectMaterialVariants(
  gltf: unknown,
): Promise<MaterialVariantSet | undefined> {
  const result = gltf as GltfResultLike | null;
  const parser = result?.parser;
  const json = parser?.json;
  const declared = json?.extensions?.KHR_materials_variants?.variants;
  if (!parser || !json || !Array.isArray(declared) || declared.length === 0) return undefined;

  const names = declared.map((entry, index) => {
    const name = (entry as { name?: unknown })?.name;
    return typeof name === "string" && name.length > 0 ? name : `variant-${index}`;
  });

  const tables = new Map<string, VariantTable>();
  const scene = result?.scene as THREE.Object3D | undefined;
  const associations = parser.associations;
  if (!scene || typeof scene.traverse !== "function" || !associations) {
    // The names are still useful (a host can show a picker), just nothing to swap.
    return { names, tables };
  }

  // Resolve every referenced material once; several primitives usually share.
  const pending: Array<Promise<void>> = [];
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const association = associations.get(mesh);
    if (!association || association.meshes === undefined) return;

    const primitiveIndex = association.primitives ?? 0;
    const primitive = json.meshes?.[association.meshes]?.primitives?.[primitiveIndex];
    const mappings = primitive?.extensions?.KHR_materials_variants?.mappings;
    if (!Array.isArray(mappings) || mappings.length === 0) return;

    const key = primitiveKey(association.meshes, primitiveIndex);
    // Tag before any clone happens: the table is looked up by this string.
    mesh.userData[MATERIAL_VARIANT_KEY] = key;

    pending.push(
      (async () => {
        const byName = new Map<string, THREE.Material>();
        for (const mapping of mappings) {
          const materialIndex = mapping?.material;
          const variantIndices = mapping?.variants;
          if (typeof materialIndex !== "number" || !Array.isArray(variantIndices)) continue;
          let material: unknown;
          try {
            material = await parser.getDependency?.("material", materialIndex);
          } catch {
            continue;
          }
          if (!isMaterial(material)) continue;
          for (const variantIndex of variantIndices) {
            const name = names[variantIndex as number];
            // Last mapping wins, matching how the spec reads as a list.
            if (name !== undefined) byName.set(name, material);
          }
        }
        if (byName.size === 0) return;
        tables.set(key, { base: mesh.material as THREE.Material, byName });
      })(),
    );
  });

  await Promise.all(pending);
  return { names, tables };
}

/** The table for a mesh instance, following the clone-surviving `userData` tag. */
export function variantTableFor(
  mesh: THREE.Object3D,
  set: MaterialVariantSet | undefined,
): VariantTable | undefined {
  if (!set) return undefined;
  const key = mesh.userData?.[MATERIAL_VARIANT_KEY];
  return typeof key === "string" ? set.tables.get(key) : undefined;
}
