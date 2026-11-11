import {
  AssetCache,
  createDocumentFromAsset,
  createFileBundleUrl,
  createUniversalAssetLoader,
  inspectModel,
  type FileBundle,
  type SceneDocument,
  type Supported3DFormat,
} from "@scenio/scene-editor";
import * as THREE from "three";
import { createSingleModelDoc, showcaseDoc } from "../bootstrap";

type AssetFactoryResult =
  | THREE.Object3D
  | { object: THREE.Object3D; animations?: THREE.AnimationClip[] };

type AssetFactory = () => AssetFactoryResult;

/** Studio framing for a freshly opened model: 3/4 view, grid on, dark backdrop. */
const STUDIO_VIEW = {
  camera: { position: [4.4, 2.8, 5.2] as [number, number, number], target: [0, 1.25, 0] as [number, number, number], fov: 48 },
  environment: { background: "#0c0e12", gridVisible: true },
};

/**
 * ModelLoader: owns the asset registry, lazy GLTF loading and the shared
 * `AssetCache` used by the stdio runtime.
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
  private readonly demoAssetLoader;
  private readonly assetCache: AssetCache;
  /** Blob URLs of the last upload; revoked when the next one replaces them. */
  private bundle: FileBundle | null = null;
  private uploadSeq = 0;

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

    this.demoAssetLoader = async (assetId: string) => {
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
  ): Promise<{ doc: SceneDocument; filename: string; format: Supported3DFormat }> {
    if (typeof urlOrFile === "string") {
      const filename = customName || urlOrFile.split("/").pop()?.split("?")[0] || "Custom Model";
      return this.#createDoc(urlOrFile, filename);
    }
    const loaded = await this.createFilesModelDoc([urlOrFile]);
    if (customName) {
      // The label is the user's, the file name is the asset's.
      const object = loaded.doc.objects[0];
      if (object) object.name = customName;
    }
    return loaded;
  }

  /**
   * Create a document from a dropped/picked bundle. A `.gltf` arrives with its
   * `.bin` and textures; `createFileBundleUrl()` rewrites those relative URIs to
   * Blob URLs and hands back the asset id (which keeps the format extension).
   */
  async createFilesModelDoc(
    files: File[],
  ): Promise<{ doc: SceneDocument; filename: string; format: Supported3DFormat }> {
    const bundle = await createFileBundleUrl(files, {
      assetIdPrefix: `upload-${++this.uploadSeq}`,
    });
    this.bundle?.dispose();
    this.bundle = bundle;
    this.registry.set(bundle.assetId, bundle.url);

    return {
      doc: this.#documentFor(bundle.assetId, bundle.name),
      filename: bundle.files[0]?.name ?? bundle.name,
      format: bundle.format,
    };
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

  #createDoc(
    url: string,
    filename: string,
  ): { doc: SceneDocument; filename: string; format: Supported3DFormat } {
    const assetId = `custom-${++this.uploadSeq}`;
    this.registry.set(assetId, url);
    return {
      doc: this.#documentFor(assetId, filename.replace(/\.[^/.]+$/, "")),
      filename,
      format: formatOf(filename),
    };
  }

  #documentFor(assetId: string, name: string): SceneDocument {
    return createDocumentFromAsset({ assetId, name, view: STUDIO_VIEW });
  }
}

const SUPPORTED_FILE_EXTENSIONS: readonly Supported3DFormat[] = ["gltf", "glb", "obj", "stl"];

function formatOf(name: string): Supported3DFormat {
  const ext = name.split("?")[0]?.split(".").pop()?.toLowerCase();
  return SUPPORTED_FILE_EXTENSIONS.find((format) => format === ext) ?? "glb";
}
