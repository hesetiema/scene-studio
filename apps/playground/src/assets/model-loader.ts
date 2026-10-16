import { DEFAULT_VIEW_STATE, type SceneDocument, type AssetLoader, createUniversalAssetLoader, inspectModel } from "@scenio/scene-editor";
import { AssetCache } from "@scenio/scene-editor";
import * as THREE from "three";
import {
  COMFORTABLE_MECHA_CAM_POS,
  COMFORTABLE_MECHA_TARGET,
  createSingleModelDoc,
  defaultMultiDoc,
  mechaAssemblyDoc,
} from "../bootstrap";

/**
 * ModelLoader: owns asset registry, lazy GLTF loading, AssetCache,
 * and SceneDocument creation for preset / custom models.
 * Extracted from main.ts so main.ts only handles host + UI wiring.
 */
export class ModelLoader {
  /** Universal asset registry for built-in and dynamically registered models */
  private readonly registry = new Map<string, string | (() => THREE.Object3D)>([
    // Primary generic identifiers
    ["mecha-shells", "/assets/mecha-shells.glb"],
    ["mecha-torso", "/assets/mecha-torso.glb"],
    ["mecha-head", "/assets/mecha-head.glb"],
    ["crystal-prism", "/assets/tri.glb"],
    // Backward-compatible aliases
    ["bionic-chassis", "/assets/mecha-shells.glb"],
    ["mechanical-torso", "/assets/mecha-torso.glb"],
    ["sensor-head", "/assets/mecha-head.glb"],
    ["kestrel-shells", "/assets/mecha-shells.glb"],
    ["kestrel-torso", "/assets/mecha-torso.glb"],
    ["kestrel-head", "/assets/mecha-head.glb"],
    ["tri", "/assets/tri.glb"],
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

  private gltfLoaderInstance: unknown = null;
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
        const root = new THREE.Group();
        root.add(customFactory());
        return { scene: root, metadata: inspectModel(root) };
      }

      const url = typeof customFactory === "string" ? customFactory : assetId;

      const isMechaPart =
        assetId.includes("shells") ||
        assetId.includes("torso") ||
        assetId.includes("head") ||
        assetId.includes("chassis");

      if (isMechaPart) {
        const loader = await this.getMechaGltfLoader();
        const gltf = await loader.loadAsync(url);
        const root = gltf.scene;
        root.scale.setScalar(0.004);
        root.position.y += 1.0;
        root.updateMatrixWorld(true);
        return { scene: root, metadata: inspectModel(root) };
      }

      if (assetId === "crystal-prism" || assetId === "tri") {
        const loader = await this.getMechaGltfLoader();
        const gltf = await loader.loadAsync(url);
        const root = gltf.scene;
        root.position.y += 1.0;
        root.updateMatrixWorld(true);
        return { scene: root, metadata: inspectModel(root) };
      }

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

  /** Lazy loader for MeshoptDecoder and GLTFLoader. */
  private async getMechaGltfLoader() {
    if (!this.gltfLoaderInstance) {
      const [gltfMod, meshoptMod] = await Promise.all([
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/libs/meshopt_decoder.module.js").catch(() => null),
      ]);
      const loader = new gltfMod.GLTFLoader();
      if (meshoptMod && "MeshoptDecoder" in meshoptMod) {
        try {
          const decoder = (meshoptMod as { MeshoptDecoder: { ready?: Promise<void> } }).MeshoptDecoder;
          if (decoder?.ready) {
            await decoder.ready;
          }
          loader.setMeshoptDecoder(decoder as Parameters<typeof loader.setMeshoptDecoder>[0]);
        } catch {
          // proceed
        }
      }
      this.gltfLoaderInstance = loader;
    }
    return this.gltfLoaderInstance as { loadAsync(url: string): Promise<{ scene: THREE.Object3D }> };
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
    let url: string;
    let filename: string;

    if (typeof urlOrFile === "string") {
      url = urlOrFile;
      filename = customName || url.split("/").pop()?.split("?")[0] || "Custom Model";
    } else {
      url = URL.createObjectURL(urlOrFile);
      filename = customName || urlOrFile.name;
    }

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
    if (value === "mecha-assembly") {
      return { doc: structuredClone(mechaAssemblyDoc), telemetryName: "Complete Mecha Assembly", telemetryFormat: "GLTF / GLB (Multi-Part)" };
    }
    if (value === "exo-chassis") {
      const doc = createSingleModelDoc("mecha-shells", "Exo-Chassis Armor Shell");
      return { doc, telemetryName: "Exo-Chassis Armor Shell", telemetryFormat: "GLTF / GLB" };
    }
    if (value === "core-torso") {
      const doc = createSingleModelDoc("mecha-torso", "Internal Torso Core");
      return { doc, telemetryName: "Internal Torso Core", telemetryFormat: "GLTF / GLB" };
    }
    if (value === "sensor-head") {
      const doc = createSingleModelDoc("mecha-head", "Sensor Pod Optics");
      return { doc, telemetryName: "Sensor Pod Optics", telemetryFormat: "GLTF / GLB" };
    }
    if (value === "polyhedral-prism") {
      const doc = createSingleModelDoc("crystal-prism", "Polyhedral Prism");
      return { doc, telemetryName: "Polyhedral Prism", telemetryFormat: "GLTF / GLB" };
    }
    if (value === "procedural-assembly" || value === "default-assembly") {
      return { doc: structuredClone(defaultMultiDoc), telemetryName: "Multi-Geometry Assembly", telemetryFormat: "Procedural Mesh" };
    }
    return null;
  }
}
