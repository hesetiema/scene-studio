import * as THREE from "three";
import { AssetError, AssetErrorCode } from "./asset-error";
import { assetFormatHint } from "./format";
import type { LoadedAsset } from "./asset-cache";

export const UNIVERSAL_SUPPORTED_FORMATS = ["glb", "gltf", "obj", "stl"] as const;
export type Supported3DFormat = (typeof UNIVERSAL_SUPPORTED_FORMATS)[number];

export interface ModelMetadata {
  vertexCount: number;
  triangleCount: number;
  meshCount: number;
  boundingBox: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

export function inspectModel(object: THREE.Object3D): ModelMetadata {
  let vertexCount = 0;
  let triangleCount = 0;
  let meshCount = 0;

  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      meshCount++;
      const mesh = child as THREE.Mesh;
      const geom = mesh.geometry;
      if (geom) {
        if (geom.index) {
          triangleCount += geom.index.count / 3;
        } else if (geom.attributes.position) {
          triangleCount += geom.attributes.position.count / 3;
        }
        if (geom.attributes.position) {
          vertexCount += geom.attributes.position.count;
        }
      }
    }
  });

  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());

  return {
    vertexCount,
    triangleCount: Math.round(triangleCount),
    meshCount,
    boundingBox: {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
      size: [size.x, size.y, size.z],
    },
  };
}

export function detectFormatFromUrl(url: string, assetId?: string): Supported3DFormat {
  if (url.startsWith("data:model/gltf-binary") || url.startsWith("data:model/gltf+json")) {
    return "glb";
  }
  // URL first, asset id second — Blob URLs (`loadFiles`) carry no extension,
  // and a dotted path segment is not an extension.
  const hint = assetFormatHint(url, assetId);
  if (hint === "glb" || hint === "gltf" || hint === "obj" || hint === "stl") {
    return hint;
  }
  return "glb";
}

export interface UniversalAssetLoaderOptions {
  resolveUrl?: (assetId: string) => string | URL | Promise<string | URL>;
  dracoDecoderPath?: string;
  defaultMaterial?: THREE.Material;
  /** Automatically center model at origin on ground grid (y = 0) and scale to standard dimensions if needed. */
  normalize?: boolean;
  targetSize?: number;
}

/**
 * Universal 3D Asset Loader supporting GLB, GLTF (with Draco & Meshopt compression),
 * OBJ and STL formats, from remote URLs, blob objects, or local uploads.
 */
export function createUniversalAssetLoader(options: UniversalAssetLoaderOptions = {}) {
  const {
    resolveUrl = (id) => id,
    dracoDecoderPath = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/",
    defaultMaterial,
    normalize = true,
    targetSize = 2.5,
  } = options;

  let gltfLoaderPromise: Promise<unknown> | null = null;
  let dracoLoaderInstance: unknown = null;

  async function getGltfLoader() {
    if (!gltfLoaderPromise) {
      gltfLoaderPromise = Promise.all([
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/loaders/DRACOLoader.js").catch(() => null),
        import("three/examples/jsm/libs/meshopt_decoder.module.js").catch(() => null),
      ]).then(async ([gltfMod, dracoMod, meshoptMod]) => {
        const loader = new gltfMod.GLTFLoader();

        // Meshopt compression support
        if (meshoptMod && "MeshoptDecoder" in meshoptMod) {
          try {
            const decoder = (meshoptMod as { MeshoptDecoder: { ready?: Promise<void> } }).MeshoptDecoder;
            if (decoder?.ready) {
              await decoder.ready;
            }
            loader.setMeshoptDecoder(decoder as Parameters<typeof loader.setMeshoptDecoder>[0]);
          } catch {
            // continue if meshopt fails
          }
        }

        // Draco compression support
        if (dracoMod && dracoDecoderPath) {
          try {
            const draco = new dracoMod.DRACOLoader();
            draco.setDecoderPath(dracoDecoderPath);
            loader.setDRACOLoader(draco);
            dracoLoaderInstance = draco;
          } catch {
            // optional
          }
        }
        return loader;
      });
    }
    return gltfLoaderPromise as Promise<{
      loadAsync(url: string): Promise<{ scene: THREE.Object3D; animations?: THREE.AnimationClip[] }>;
    }>;
  }

  return async function loadUniversalAsset(assetId: string): Promise<LoadedAsset> {
    let url: string;
    try {
      const resolved = await resolveUrl(assetId);
      url = typeof resolved === "string" ? resolved : resolved.href;
    } catch (cause) {
      throw new AssetError(AssetErrorCode.ResolveFailed, `Failed to resolve asset: ${assetId}`, {
        cause,
        detail: { assetId },
      });
    }

    const format = detectFormatFromUrl(url, assetId);
    let rootObject: THREE.Object3D;
    let animations: THREE.AnimationClip[] | undefined;

    try {
      if (format === "glb" || format === "gltf") {
        const loader = await getGltfLoader();
        const gltf = await loader.loadAsync(url);
        rootObject = gltf.scene;
        animations = gltf.animations;
      } else if (format === "obj") {
        const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
        const loader = new OBJLoader();
        rootObject = await loader.loadAsync(url);
      } else if (format === "stl") {
        const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
        const loader = new STLLoader();
        const geometry = await loader.loadAsync(url);
        const mat =
          defaultMaterial ??
          new THREE.MeshStandardMaterial({
            color: 0x4f8ef7,
            roughness: 0.35,
            metalness: 0.4,
          });
        rootObject = new THREE.Mesh(geometry, mat);
      } else {
        throw new Error(`Unsupported 3D format: ${format}`);
      }
    } catch (cause) {
      throw new AssetError(AssetErrorCode.LoadFailed, `Failed to load 3D model: ${assetId}`, {
        cause,
        detail: { assetId, url, format },
      });
    }

    // Auto-normalize bounding box and ground alignment if requested
    if (normalize) {
      const rawBox = new THREE.Box3().setFromObject(rootObject);
      const rawSize = rawBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);

      // If model dimensions are outside standard range (e.g. raw CAD or millimeter scale > 10 units)
      if (maxDim > 10 || (maxDim > 0 && maxDim < 0.2)) {
        const scale = targetSize / maxDim;
        rootObject.scale.multiplyScalar(scale);
      }
      rootObject.updateMatrixWorld(true);

      // Re-center on X/Z and rest on ground Y = 0
      const alignedBox = new THREE.Box3().setFromObject(rootObject);
      rootObject.position.x -= (alignedBox.min.x + alignedBox.max.x) / 2;
      rootObject.position.y -= alignedBox.min.y;
      rootObject.position.z -= (alignedBox.min.z + alignedBox.max.z) / 2;
      rootObject.updateMatrixWorld(true);

      // The mount step overwrites the root transform with the document values
      // (`applyDtoTransform`), so the normalization has to live one level down
      // behind an identity wrapper — otherwise a 154-unit model snaps back to
      // its raw scale and the camera frames it from 200 units away.
      const normalized = new THREE.Group();
      normalized.name = rootObject.name;
      normalized.add(rootObject);
      rootObject = normalized;
    }

    // Inspect and attach metadata
    const metadata = inspectModel(rootObject);

    const asset: LoadedAsset = {
      scene: rootObject,
      metadata,
      dispose: () => {
        (rootObject as { dispose?: () => void }).dispose?.();
        if (dracoLoaderInstance) {
          (dracoLoaderInstance as { dispose?: () => void }).dispose?.();
        }
      },
    };
    if (animations && animations.length > 0) {
      asset.animations = animations;
    }
    return asset;
  };
}
