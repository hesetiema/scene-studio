import { DEFAULT_VIEW_STATE, type SceneDocument, type AssetLoader, createUniversalAssetLoader, inspectModel } from "@scenio/scene-editor";
import { AssetCache } from "@scenio/scene-editor";
import * as THREE from "three";
import { createSingleModelDoc, showcaseDoc } from "../bootstrap";

type AssetFactoryResult =
  | THREE.Object3D
  | { object: THREE.Object3D; animations?: THREE.AnimationClip[] };

type AssetFactory = () => AssetFactoryResult;

/**
 * ModelLoader: owns asset registry, lazy GLTF loading, AssetCache,
 * and SceneDocument creation for preset / custom models.
 * Extracted from main.ts so main.ts only handles host + UI wiring.
 *
 * Built-in samples are the Khronos glTF sample assets served by
 * `KhronosGroup/GLTF-Sample-Viewer` (the models themselves live in
 * `KhronosGroup/glTF-Sample-Assets`), copied into `public/assets/`.
 */
export class ModelLoader {
  /** Universal asset registry for built-in and dynamically registered models */
  private readonly registry = new Map<string, string | AssetFactory>([
    ["damaged-helmet", "/assets/DamagedHelmet.glb"],
    ["boom-box", "/assets/BoomBox.glb"],
    ["fox", "/assets/Fox.glb"],
    ["water-bottle", "/assets/WaterBottle.glb"],
    ["milk-truck", "/assets/CesiumMilkTruck.glb"],
    [
      "gem",
      () =>
        new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.7),
          new THREE.MeshStandardMaterial({
            color: 0x38e2ff,
            metalness: 0.3,
            roughness: 0.15,
            flatShading: true,
          }),
        ),
    ],
  ]);

  private readonly universalFallbackLoader;
  private readonly demoAssetLoader: AssetLoader;
  private readonly assetCache: AssetCache;

  constructor() {
    this.universalFallbackLoader = createUniversalAssetLoader({
      resolveUrl: async (assetId) => {
        const entry = this.registry.get(assetId);
        if (typeof entry === "string") return entry;
        return assetId;
      },
      dracoDecoderPath: "https://www.gstatic.com/draco/versioned/decoders/1.5.7/",
      normalize: true,
      targetSize: 2.5,
    });

    this.demoAssetLoader = async (assetId) => {
      const customFactory = this.registry.get(assetId);
      if (typeof customFactory === "function") {
        const built = customFactory();
        const root = new THREE.Group();
        if (built instanceof THREE.Object3D) {
          root.add(built);
          return { scene: root, metadata: inspectModel(root) };
        }
        root.add(built.object);
        return {
          scene: root,
          metadata: inspectModel(root),
          ...(built.animations?.length ? { animations: built.animations } : {}),
        };
      }

      // GLB / glTF / OBJ / STL: the universal loader resolves, normalizes
      // (center + scale + rest on y = 0) and forwards animation clips.
      return this.universalFallbackLoader(assetId);
    };

    this.assetCache = new AssetCache(this.demoAssetLoader);
  }

  /** Shared AssetCache instance for the ThreeRuntime. */
  getAssetCache(): AssetCache {
    return this.assetCache;
  }

  /** Register a custom asset URL or procedural factory. */
  registerAsset(assetId: string, urlOrFactory: string | (() => THREE.Object3D)): void {
    this.registry.set(assetId, urlOrFactory);
  }

  /**
   * Create a SceneDocument for a custom uploaded / remote 3D model.
   * Registers the asset URL and returns the doc + display metadata.
   * Caller is responsible for el.loadDocument(), host/UI updates, and camera framing.
   */
  async createCustomModelDoc(
    urlOrFile: string | File,
    customName?: string,
  ): Promise<{ doc: SceneDocument; filename: string; format: string }> {
    if (typeof urlOrFile === "string") {
      const filename = customName || urlOrFile.split("/").pop()?.split("?")[0] || "Custom Model";
      return this.#createDoc(urlOrFile, filename);
    }
    return this.#createDoc(URL.createObjectURL(urlOrFile), customName || urlOrFile.name);
  }

  /**
   * Create a document from a dropped/picked bundle. A `.gltf` arrives with its
   * `.bin` and textures; those relative URIs are rewritten to blob URLs so the
   * loader resolves everything in place (reference: `assetMap` URL modifier).
   */
  async createFilesModelDoc(
    files: File[],
  ): Promise<{ doc: SceneDocument; filename: string; format: string }> {
    const primary = pickPrimaryFile(files);
    if (!primary) {
      throw new Error("未找到支持的 3D 文件（.glb / .gltf / .obj / .stl）");
    }
    const url = await bundleUrl(primary, files);
    return this.#createDoc(url, primary.name);
  }

  #createDoc(
    url: string,
    filename: string,
  ): { doc: SceneDocument; filename: string; format: string } {
    const assetId = `custom-${Date.now()}`;
    this.registry.set(assetId, url);

    const cleanExt = filename.split(".").pop()?.toLowerCase() || "glb";

    const newDoc: SceneDocument = {
      schemaVersion: 2,
      sceneId: `scene-${Date.now()}`,
      revision: 0,
      view: {
        ...DEFAULT_VIEW_STATE,
        camera: { position: [4.4, 2.8, 5.2], target: [0, 1.25, 0], fov: 48 },
        environment: { background: "#0c0e12", gridVisible: true },
      },
      objects: [
        {
          id: `obj-${Date.now()}`,
          type: "mesh",
          name: filename.replace(/\.[^/.]+$/, ""),
          assetId: assetId,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      ],
    };

    return { doc: newDoc, filename, format: cleanExt };
  }

  /**
   * Create a SceneDocument for a predefined model option (dropdown value).
   * Returns null if the option is unknown.
   */
  createModelDocByOption(
    value: string,
  ): { doc: SceneDocument; telemetryName: string; telemetryFormat: string } | null {
    if (value === "damaged-helmet") {
      return {
        doc: structuredClone(showcaseDoc),
        telemetryName: "Damaged Helmet",
        telemetryFormat: "glTF / GLB（Khronos 示例）",
      };
    }
    if (value === "boom-box") {
      const doc = createSingleModelDoc("boom-box", "Boom Box");
      return { doc, telemetryName: "Boom Box", telemetryFormat: "glTF / GLB（自发光材质）" };
    }
    if (value === "fox") {
      const doc = createSingleModelDoc("fox", "Fox");
      return {
        doc,
        telemetryName: "Fox（含动画）",
        telemetryFormat: "glTF / GLB + 骨骼动画",
      };
    }
    if (value === "water-bottle") {
      const doc = createSingleModelDoc("water-bottle", "Water Bottle");
      return { doc, telemetryName: "Water Bottle", telemetryFormat: "glTF / GLB（PBR 玻璃瓶）" };
    }
    if (value === "milk-truck") {
      const doc = createSingleModelDoc("milk-truck", "Cesium Milk Truck");
      return {
        doc,
        telemetryName: "Cesium Milk Truck（含动画）",
        telemetryFormat: "glTF / GLB（多部件 + 动画）",
      };
    }
    return null;
  }
}

const SUPPORTED_FILE_EXTENSIONS = ["gltf", "glb", "obj", "stl"] as const;

function fileExtension(name: string): string {
  return (
    name
      .split("?")[0]!
      .split(".")
      .pop()
      ?.toLowerCase() ?? ""
  );
}

/** Prefer a .gltf bundle (it owns external resources), then self-contained .glb. */
function pickPrimaryFile(files: File[]): File | null {
  for (const ext of SUPPORTED_FILE_EXTENSIONS) {
    const match = files.find((file) => fileExtension(file.name) === ext);
    if (match) return match;
  }
  return null;
}

/**
 * Inline a .gltf bundle: map every relative buffer/image URI to a Blob URL from
 * the dropped file set, then hand the loader a single JSON blob. This is the
 * playground equivalent of three-gltf-viewer's `assetMap` URL modifier.
 */
async function bundleUrl(primary: File, files: File[]): Promise<string> {
  if (fileExtension(primary.name) !== "gltf") return URL.createObjectURL(primary);

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await primary.text()) as Record<string, unknown>;
  } catch {
    return URL.createObjectURL(primary);
  }

  const byName = new Map<string, File>();
  for (const file of files) {
    if (file === primary) continue;
    byName.set(file.name.toLowerCase(), file);
    const base = file.name.split("/").pop()?.toLowerCase();
    if (base) byName.set(base, file);
  }

  const resolve = (uri: string): string | null => {
    if (!uri || uri.startsWith("data:") || /^(blob:|https?:|file:)/i.test(uri)) return null;
    let clean = uri.replace(/^\.\//, "");
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // keep the raw URI when it is not valid percent-encoding
    }
    const base = clean.split("/").pop()?.toLowerCase();
    const file = byName.get(clean.toLowerCase()) ?? (base ? byName.get(base) : undefined);
    return file ? URL.createObjectURL(file) : null;
  };

  for (const key of ["buffers", "images"]) {
    const list = json[key];
    if (!Array.isArray(list)) continue;
    for (const item of list as Array<{ uri?: unknown }>) {
      if (typeof item?.uri !== "string") continue;
      const blobUrl = resolve(item.uri);
      if (blobUrl) item.uri = blobUrl;
    }
  }

  const blob = new Blob([JSON.stringify(json)], { type: "model/gltf+json" });
  return URL.createObjectURL(blob);
}
