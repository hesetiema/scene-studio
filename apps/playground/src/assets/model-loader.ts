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

type AssetFactoryResult =
  | THREE.Object3D
  | { object: THREE.Object3D; animations?: THREE.AnimationClip[] };

type AssetFactory = () => AssetFactoryResult;

/**
 * ModelLoader: owns asset registry, lazy GLTF loading, AssetCache,
 * and SceneDocument creation for preset / custom models.
 * Extracted from main.ts so main.ts only handles host + UI wiring.
 */
export class ModelLoader {
  /** Universal asset registry for built-in and dynamically registered models */
  private readonly registry = new Map<string, string | AssetFactory>([
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
    ["kinetic-orb", createKineticOrb],
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
        return {
          scene: root,
          metadata: inspectModel(root),
          ...(gltf.animations?.length ? { animations: gltf.animations } : {}),
        };
      }

      if (assetId === "crystal-prism" || assetId === "tri") {
        const loader = await this.getMechaGltfLoader();
        const gltf = await loader.loadAsync(url);
        const root = gltf.scene;
        root.position.y += 1.0;
        root.updateMatrixWorld(true);
        return {
          scene: root,
          metadata: inspectModel(root),
          ...(gltf.animations?.length ? { animations: gltf.animations } : {}),
        };
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
    return this.gltfLoaderInstance as {
      loadAsync(url: string): Promise<{ scene: THREE.Object3D; animations?: THREE.AnimationClip[] }>;
    };
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
    if (value === "kinetic-orb") {
      const doc = createSingleModelDoc("kinetic-orb", "Kinetic Orb");
      doc.view.camera = { position: [3.4, 2.4, 4.2], target: [0, 0.9, 0], fov: 48 };
      return { doc, telemetryName: "Kinetic Orb (Animated)", telemetryFormat: "Procedural + Clips" };
    }
    return null;
  }
}

/** Demo asset with two clips — exercises the animation transport end to end. */
function createKineticOrb(): { object: THREE.Object3D; animations: THREE.AnimationClip[] } {
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.85, 2),
    new THREE.MeshStandardMaterial({
      color: 0x38e2ff,
      metalness: 0.55,
      roughness: 0.18,
      emissive: 0x063a4a,
      emissiveIntensity: 0.5,
    }),
  );
  core.name = "core";

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.05, 8, 96),
    new THREE.MeshStandardMaterial({
      color: 0x9fe9ff,
      metalness: 0.8,
      roughness: 0.25,
      emissive: 0x0a2a33,
      emissiveIntensity: 0.4,
    }),
  );
  ring.name = "ring";
  ring.rotation.x = Math.PI / 2;

  const satellite = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0xffab40,
      emissive: 0xff7a00,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    }),
  );
  satellite.name = "satellite";
  satellite.position.set(1.6, 0, 0);

  group.add(core, ring, satellite);
  return { object: group, animations: [createOrbitClip(), createBreatheClip()] };
}

function createOrbitClip(): THREE.AnimationClip {
  const duration = 4;
  const segments = 48;
  const radius = 1.6;
  const times: number[] = [];
  const values: number[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * duration;
    const angle = (i / segments) * Math.PI * 2;
    times.push(t);
    values.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  }

  return new THREE.AnimationClip("Orbit", duration, [
    new THREE.VectorKeyframeTrack("satellite.position", times, values),
  ]);
}

function createBreatheClip(): THREE.AnimationClip {
  return new THREE.AnimationClip("Breathe", 2.5, [
    new THREE.VectorKeyframeTrack(
      "core.scale",
      [0, 1.25, 2.5],
      [1, 1, 1, 1.22, 1.22, 1.22, 1, 1, 1],
    ),
  ]);
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
