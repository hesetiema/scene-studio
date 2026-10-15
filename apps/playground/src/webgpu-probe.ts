/**
 * D1 WebGPU evaluation probe — real-asset matrix against WebGPURenderer.
 *
 * Two-phase handshake with e2e/webgpu-eval.spec.ts:
 *   phase 1: build renderer + runtime, load doc (box placeholder + 2× shared
 *            tri.glb asset), run checks → report.status = "ready"
 *   phase 2: Playwright screenshots the canvas, then calls finish() which
 *            disposes everything, records teardown checks → "done"
 *
 * conclusion: "webgpu-viable" | "keep-webgl" (reason carries the evidence).
 */
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import * as WEBGPU_NS from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  AssetCache,
  createResolverAssetLoader,
  type SceneDocument,
} from "@scenio/scene-editor";
import { ThreeRuntime } from "@scenio/scene-editor/three";

interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

type ProbeConclusion = "webgpu-viable" | "keep-webgl" | "pending";

interface ProbeReport {
  status: "running" | "ready" | "done" | "failed";
  conclusion: ProbeConclusion;
  conclusionReason: string;
  timestamp: string;
  userAgent: string;
  gpuPresent: boolean;
  adapter: boolean;
  adapterInfo: string;
  backend: "webgpu" | "webgl" | "none";
  checks: ProbeCheck[];
  errors: string[];
  runtimeErrors: Array<{ code: string; message: string }>;
  notCovered: string[];
}

interface ProbeApi {
  report: ProbeReport;
  finish: () => Promise<void>;
}

declare global {
  interface Window {
    __webgpuProbe: ProbeApi;
  }
}

/** lib.dom has no WebGPU types — minimal local shape (D1 probe only). */
type NavigatorWithGPU = Navigator & {
  gpu?: {
    requestAdapter?: (options?: unknown) => Promise<{
      info?: { vendor?: string; architecture?: string; description?: string };
    } | null>;
  };
};

const report: ProbeReport = {
  status: "running",
  conclusion: "pending",
  conclusionReason: "probe still running",
  timestamp: new Date().toISOString(),
  userAgent: navigator.userAgent,
  gpuPresent: false,
  adapter: false,
  adapterInfo: "",
  backend: "none",
  checks: [],
  errors: [],
  runtimeErrors: [],
  notCovered: ["ktx2", "draco"],
};

const checkMap = new Map<string, ProbeCheck>();
let runtime: ThreeRuntime | null = null;
let cache: AssetCache | null = null;
let finished = false;

function setCheck(name: string, ok: boolean, detail: string): void {
  checkMap.set(name, { name, ok, detail });
  report.checks = [...checkMap.values()];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function finalizeConclusion(): void {
  if (!report.gpuPresent || !report.adapter) {
    report.conclusion = "keep-webgl";
    report.conclusionReason = report.gpuPresent
      ? "no-adapter: requestAdapter returned null/timed out"
      : "no-webgpu: navigator.gpu missing";
    return;
  }
  if (report.backend !== "webgpu") {
    report.conclusion = "keep-webgl";
    report.conclusionReason = "fallback: WebGPURenderer fell back to WebGL backend";
    return;
  }
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    report.conclusion = "keep-webgl";
    report.conclusionReason = `checks-failed: ${failed.map((c) => c.name).join(", ")}`;
    return;
  }
  report.conclusion = "webgpu-viable";
  report.conclusionReason = "all checks passed on WebGPU backend";
}

window.__webgpuProbe = {
  report,
  finish: async () => {
    if (finished) return;
    finished = true;
    try {
      runtime?.flushDisposers();
      const refCount = cache?.refCount("tri") ?? -1;
      const stillHeld = cache?.has("tri") ?? true;
      setCheck(
        "dispose",
        refCount === 0 && !stillHeld,
        `refCount(tri)=${refCount} held=${stillHeld} (expect 0/false after flush)`,
      );
    } catch (err) {
      setCheck("dispose", false, `flushDisposers threw: ${String(err)}`);
    }
    setCheck(
      "no-runtime-errors",
      report.runtimeErrors.length === 0,
      `runtime error events=${report.runtimeErrors.length}`,
    );
    finalizeConclusion();
    report.status = "done";
  },
};

window.addEventListener("error", (e) => report.errors.push(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  report.errors.push(`unhandledrejection: ${String(e.reason)}`),
);

function raf2(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function phase1(): Promise<void> {
  // --- GPU API presence -----------------------------------------------------
  const nav = navigator as NavigatorWithGPU;
  report.gpuPresent = !!nav.gpu;
  setCheck(
    "gpu-api-present",
    report.gpuPresent,
    report.gpuPresent ? "navigator.gpu present" : "navigator.gpu missing",
  );

  let adapter: { info?: { vendor?: string; architecture?: string; description?: string } } | null = null;
  if (nav.gpu?.requestAdapter) {
    try {
      adapter = await withTimeout(nav.gpu.requestAdapter(), 5000);
    } catch (err) {
      report.errors.push(`requestAdapter: ${String(err)}`);
      adapter = null;
    }
  }
  report.adapter = adapter != null;
  if (adapter?.info) {
    report.adapterInfo = [adapter.info.vendor, adapter.info.architecture, adapter.info.description]
      .filter(Boolean)
      .join(" / ");
  }
  setCheck(
    "gpu-adapter",
    report.adapter,
    report.adapter ? `requestAdapter ok (${report.adapterInfo || "no adapter info"})` : "requestAdapter null/timeout",
  );

  // --- class identity: 'three' vs 'three/webgpu' must share core classes ---
  const coreShared =
    (THREE as unknown as { Scene?: unknown }).Scene ===
    (WEBGPU_NS as unknown as { Scene?: unknown }).Scene;
  setCheck(
    "class-identity-shared",
    coreShared,
    coreShared ? "THREE.Scene identical across three and three/webgpu" : "Scene differs — bundler duplicated three.core",
  );

  // --- WebGPURenderer init (canvas cast: RendererParameters lacks canvas) ---
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const params = { canvas, antialias: true } as ConstructorParameters<typeof WebGPURenderer>[0];
  let renderer: WebGPURenderer;
  try {
    renderer = new WebGPURenderer(params);
    await renderer.init();
    setCheck("renderer-init", true, "await renderer.init() resolved");
  } catch (err) {
    report.errors.push(`renderer-init: ${String(err)}`);
    setCheck("renderer-init", false, String(err));
    setCheck("backend-webgpu", false, "skipped: renderer-init failed");
    setCheck("load-document", false, "skipped: renderer-init failed");
    setCheck("shared-refcount", false, "skipped: renderer-init failed");
    setCheck("gltf-load", false, "skipped: renderer-init failed");
    setCheck("pick-box", false, "skipped: renderer-init failed");
    setCheck("pick-asset", false, "skipped: renderer-init failed");
    setCheck("transform", false, "skipped: renderer-init failed");
    setCheck("gizmo-mount", false, "skipped: renderer-init failed");
    setCheck("render-no-throw", false, "skipped: renderer-init failed");
    report.status = "ready";
    return;
  }

  // --- backend identity: silent WebGL fallback is the D1 trap --------------
  const backendObj = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
  report.backend = backendObj?.isWebGPUBackend ? "webgpu" : backendObj ? "webgl" : "none";
  setCheck(
    "backend-webgpu",
    report.backend === "webgpu",
    `backend=${report.backend}${report.backend === "webgl" ? " (getFallback engaged — no real WebGPU)" : ""}`,
  );

  // --- runtime + resolver asset pipeline (D11/D12/D16) ---------------------
  cache = new AssetCache(
    createResolverAssetLoader({
      resolver: {
        resolve: async (assetId: string) => {
          if (assetId === "tri") return "/assets/tri.glb";
          throw new Error(`unknown assetId: ${assetId}`);
        },
      },
      gltfLoader: new GLTFLoader(),
    }),
  );
  runtime = new ThreeRuntime({
    canvas,
    rendererFactory: () => renderer,
    assetCache: cache,
  });
  runtime.events.on("error", (payload) =>
    report.runtimeErrors.push({ code: payload.code, message: payload.message }),
  );

  const doc: SceneDocument = {
    schemaVersion: 1,
    sceneId: "webgpu-probe",
    revision: 0,
    objects: [
      { id: "box-1", type: "mesh", name: "Box", position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { id: "tri-1", type: "mesh", name: "Tri1", assetId: "tri", position: [2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { id: "tri-2", type: "mesh", name: "Tri2", assetId: "tri", position: [-2, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ],
  };

  try {
    await runtime.loadDocument(doc);
    setCheck("load-document", true, "3 objects (box placeholder + 2 asset instances)");
  } catch (err) {
    setCheck("load-document", false, String(err));
  }

  const refCount = cache.refCount("tri");
  setCheck("shared-refcount", refCount === 2, `refCount(tri)=${refCount} (expect 2 for tri-1 + tri-2)`);

  // --- glTF materialization: real triangle content (3 positions) -----------
  const tri1 = runtime.getObjectById("tri-1");
  let vertexCount = -1;
  tri1?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && vertexCount === -1) {
      vertexCount = mesh.geometry.getAttribute("position")?.count ?? -1;
    }
  });
  setCheck(
    "gltf-load",
    !!tri1 && vertexCount === 3,
    `tri-1 present=${!!tri1} vertexCount=${vertexCount} (expect 3 from tri.glb)`,
  );

  // --- raycast picks: placeholder (non-recursive OK) vs asset Group root ---
  const rect = canvas.getBoundingClientRect();
  const toClient = (world: THREE.Vector3): { clientX: number; clientY: number } => {
    const ndc = world.clone().project(runtime!.camera);
    return {
      clientX: rect.left + ((ndc.x + 1) / 2) * rect.width,
      clientY: rect.top + ((1 - ndc.y) / 2) * rect.height,
    };
  };

  const boxWorld = runtime.getObjectById("box-1")!.getWorldPosition(new THREE.Vector3());
  const boxPoint = toClient(boxWorld);
  const pickedBox = runtime.pick(boxPoint.clientX, boxPoint.clientY);
  setCheck("pick-box", pickedBox === "box-1", `picked=${pickedBox} (expect box-1)`);

  if (tri1 && vertexCount === 3) {
    // remove winding as a variable: pick pipeline is what is under test
    tri1.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of materials) m.side = THREE.DoubleSide;
      }
    });
    tri1.updateWorldMatrix(true, true);
    let triMesh: THREE.Mesh | null = null;
    tri1.traverse((o) => {
      if (!triMesh && (o as THREE.Mesh).isMesh) triMesh = o as THREE.Mesh;
    });
    const attr = (triMesh as THREE.Mesh).geometry.getAttribute("position");
    const centroid = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
      centroid.add(new THREE.Vector3().fromBufferAttribute(attr, i));
    }
    centroid.divideScalar(attr.count).applyMatrix4((triMesh as THREE.Mesh).matrixWorld);
    const triPoint = toClient(centroid);
    const pickedTri = runtime.pick(triPoint.clientX, triPoint.clientY);
    setCheck(
      "pick-asset",
      pickedTri === "tri-1",
      `picked=${pickedTri} (expect tri-1; Group root requires recursive intersectObjects)`,
    );
  } else {
    setCheck("pick-asset", false, "skipped: tri-1 not materialized");
  }

  // --- transform mutates live object ---------------------------------------
  runtime.applyTransform("box-1", { position: [5, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  const moved = runtime.getObjectById("box-1")!.position.toArray();
  setCheck(
    "transform",
    moved[0] === 5 && moved[1] === 1,
    `box-1 position=[${moved.join(", ")}] (expect [5, 1, 0])`,
  );

  // --- gizmo (TransformControls) mounted into scene -------------------------
  await runtime.controlsReady;
  const childCount = runtime.scene.children.length;
  setCheck(
    "gizmo-mount",
    childCount >= 7,
    `scene.children=${childCount} (expect ≥7: lights 2 + grid 1 + gizmo 1 + objects 3)`,
  );

  // --- explicit render pass without throwing --------------------------------
  try {
    runtime.render();
    setCheck("render-no-throw", true, "runtime.render() completed");
  } catch (err) {
    setCheck("render-no-throw", false, String(err));
  }

  await raf2();
  report.status = "ready";
}

void phase1()
  .catch((err) => {
    report.errors.push(`phase1: ${String(err)}`);
    if (!checkMap.has("render-no-throw")) setCheck("render-no-throw", false, `skipped: ${String(err)}`);
    report.status = "failed";
  })
  .finally(() => {
    if (report.status === "running") report.status = "failed";
  });
