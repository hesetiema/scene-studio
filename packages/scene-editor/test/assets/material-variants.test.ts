import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  collectMaterialVariants,
  MATERIAL_VARIANT_KEY,
  variantTableFor,
} from "../../src/assets/material-variants";

interface FakePrimitive {
  extensions?: {
    KHR_materials_variants?: {
      mappings?: Array<{ material?: unknown; variants?: unknown }>;
    };
  };
}

/**
 * Build the shape three's GLTFLoader leaves behind: `scene`, `parser.json` and
 * `parser.associations` (which is how a Mesh maps back to its glTF primitive).
 * `scene` must be the one the meshes were added to — collection walks it.
 */
function gltfWith(options: {
  scene: THREE.Object3D;
  variants?: Array<{ name?: unknown }>;
  primitives?: FakePrimitive[];
  associations?: Array<[THREE.Object3D, { meshes?: number; primitives?: number }]>;
  materials?: Array<THREE.Material | Error>;
  meshes?: Array<{ primitives?: FakePrimitive[] }>;
}) {
  const materials = options.materials ?? [];
  const associations = new Map(options.associations ?? []);
  return {
    scene: options.scene,
    parser: {
      json: {
        ...(options.variants
          ? { extensions: { KHR_materials_variants: { variants: options.variants } } }
          : {}),
        meshes: options.meshes ?? [{ primitives: options.primitives ?? [] }],
      },
      associations,
      getDependency: vi.fn(async (_type: string, index: number) => {
        const material = materials[index];
        if (material instanceof Error) throw material;
        return material;
      }),
    },
  };
}

function meshIn(parent: THREE.Object3D, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  parent.add(mesh);
  return mesh;
}

describe("collectMaterialVariants", () => {
  it("returns undefined when the asset declares no variants", async () => {
    const scene = new THREE.Group();
    meshIn(scene, new THREE.MeshStandardMaterial());
    const gltf = { scene, parser: { json: { meshes: [{ primitives: [{}] }] }, associations: new Map() } };
    await expect(collectMaterialVariants(gltf)).resolves.toBeUndefined();
  });

  it("survives a loader that hands back no parser at all", async () => {
    await expect(collectMaterialVariants({ scene: new THREE.Group() })).resolves.toBeUndefined();
    await expect(collectMaterialVariants(null)).resolves.toBeUndefined();
  });

  it("maps each primitive's mappings to resolved materials", async () => {
    const base = new THREE.MeshStandardMaterial({ name: "base" });
    const red = new THREE.MeshStandardMaterial({ name: "red" });
    const blue = new THREE.MeshStandardMaterial({ name: "blue" });
    const scene = new THREE.Group();
    const mesh = meshIn(scene, base);

    const set = await collectMaterialVariants(
      gltfWith({
        scene,
        variants: [{ name: "Red" }, { name: "Blue" }],
        materials: [base, red, blue],
        associations: [[mesh, { meshes: 0, primitives: 0 }]],
        primitives: [
          {
            extensions: {
              KHR_materials_variants: {
                mappings: [
                  { material: 1, variants: [0] },
                  { material: 2, variants: [1] },
                ],
              },
            },
          },
        ],
      }),
    );

    expect(set?.names).toEqual(["Red", "Blue"]);
    const table = set?.tables.get("0:0");
    expect(table?.base).toBe(base);
    expect(table?.byName.get("Red")).toBe(red);
    expect(table?.byName.get("Blue")).toBe(blue);
    // The tag is what survives cloning; without it the table is unreachable.
    expect(mesh.userData[MATERIAL_VARIANT_KEY]).toBe("0:0");
  });

  it("falls back to positional names for unnamed variants", async () => {
    const base = new THREE.MeshStandardMaterial();
    const alt = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group();
    const mesh = meshIn(scene, base);

    const set = await collectMaterialVariants(
      gltfWith({
        scene,
        variants: [{ name: "Named" }, {}, { name: "" }],
        materials: [base, alt],
        associations: [[mesh, { meshes: 0, primitives: 0 }]],
        primitives: [
          { extensions: { KHR_materials_variants: { mappings: [{ material: 1, variants: [0, 1, 2] }] } } },
        ],
      }),
    );

    expect(set?.names).toEqual(["Named", "variant-1", "variant-2"]);
    // One material can back several variant names.
    expect(set?.tables.get("0:0")?.byName.get("variant-2")).toBe(alt);
  });

  it("tags the primitive a multi-primitive mesh puts the mapping on", async () => {
    const base0 = new THREE.MeshStandardMaterial();
    const base1 = new THREE.MeshStandardMaterial();
    const alt1 = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group();
    const first = meshIn(scene, base0);
    const second = meshIn(scene, base1);

    // One glTF mesh, two primitives: only the second declares a variant.
    const set = await collectMaterialVariants({
      scene,
      parser: {
        json: {
          extensions: { KHR_materials_variants: { variants: [{ name: "Alt" }] } },
          meshes: [
            {
              primitives: [
                {},
                {
                  extensions: {
                    KHR_materials_variants: { mappings: [{ material: 0, variants: [0] }] },
                  },
                },
              ],
            },
          ],
        },
        associations: new Map([
          [first, { meshes: 0, primitives: 0 }],
          [second, { meshes: 0, primitives: 1 }],
        ]),
        getDependency: async () => alt1,
      },
    });

    expect(set?.tables.has("0:0")).toBe(false);
    expect(set?.tables.get("0:1")?.base).toBe(base1);
    expect(set?.tables.get("0:1")?.byName.get("Alt")).toBe(alt1);
    expect(first.userData[MATERIAL_VARIANT_KEY]).toBeUndefined();
  });

  it("keeps the names when a material fails to resolve", async () => {
    const base = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group();
    const mesh = meshIn(scene, base);

    const set = await collectMaterialVariants(
      gltfWith({
        scene,
        variants: [{ name: "Broken" }],
        materials: [base, new Error("decode failed")],
        associations: [[mesh, { meshes: 0, primitives: 0 }]],
        primitives: [
          { extensions: { KHR_materials_variants: { mappings: [{ material: 1, variants: [0] }] } } },
        ],
      }),
    );

    // A broken mapping costs that primitive's variants, never the load.
    expect(set?.names).toEqual(["Broken"]);
    expect(set?.tables.size).toBe(0);
  });

  it("ignores malformed mappings instead of throwing", async () => {
    const base = new THREE.MeshStandardMaterial();
    const scene = new THREE.Group();
    const mesh = meshIn(scene, base);

    const set = await collectMaterialVariants(
      gltfWith({
        scene,
        variants: [{ name: "Red" }],
        materials: [base],
        associations: [[mesh, { meshes: 0, primitives: 0 }]],
        primitives: [
          {
            extensions: {
              KHR_materials_variants: {
                mappings: [{ material: "1", variants: [0] }, { variants: [0] }, { material: 0 }],
              },
            },
          },
        ],
      }),
    );

    expect(set?.names).toEqual(["Red"]);
    expect(set?.tables.size).toBe(0);
  });

  it("skips nodes three did not associate with a glTF mesh", async () => {
    const orphan = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const scene = new THREE.Group();
    scene.add(orphan);

    const set = await collectMaterialVariants(
      gltfWith({
        scene,
        variants: [{ name: "Red" }],
        materials: [],
        associations: [],
        primitives: [
          { extensions: { KHR_materials_variants: { mappings: [{ material: 0, variants: [0] }] } } },
        ],
      }),
    );

    expect(set?.names).toEqual(["Red"]);
    expect(set?.tables.size).toBe(0);
  });
});

describe("variantTableFor", () => {
  it("follows the tag a clone inherited", () => {
    const base = new THREE.MeshStandardMaterial();
    const alt = new THREE.MeshStandardMaterial();
    const source = new THREE.Mesh(new THREE.BoxGeometry(), base);
    source.userData[MATERIAL_VARIANT_KEY] = "2:1";

    const set = {
      names: ["Alt"],
      tables: new Map([["2:1", { base, byName: new Map([["Alt", alt]]) }]]),
    };

    // `Object3D.clone` deep-copies userData over JSON, so the tag survives while
    // the material references do not — exactly the split this lookup relies on.
    const clone = source.clone(true);
    expect(variantTableFor(clone, set)?.byName.get("Alt")).toBe(alt);
  });

  it("returns undefined without a set, a tag, or a matching table", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    expect(variantTableFor(mesh, undefined)).toBeUndefined();
    const set = { names: [], tables: new Map([["0:0", { base: mesh.material as THREE.Material, byName: new Map() }]]) };
    expect(variantTableFor(mesh, set)).toBeUndefined();
    mesh.userData[MATERIAL_VARIANT_KEY] = "9:9";
    expect(variantTableFor(mesh, set)).toBeUndefined();
  });
});
