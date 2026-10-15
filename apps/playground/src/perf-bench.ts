/**
 * D10 performance benchmark harness — anchors metrics + collection points.
 *
 * Scene: 1 000 placeholder boxes (design "1k 对象基准场景").
 * Metrics (design §13 table):
 *   - first-interactive: performance marks, timeOrigin → loadDocument done +
 *     controlsReady + first rendered frame
 *   - scene-load: mark around runtime.loadDocument
 *   - p95 frame time: rAF-driven render() loop, delta histogram
 *   - draw calls / triangles / geometries: renderer.info snapshots (trend)
 *   - unload-zero: scene children + GPU resource counters back to baseline
 *     (hard), JS heap recorded as info-only
 *
 * The page only MEASURES — thresholds are applied by e2e/perf.spec.ts so CI
 * can override them (SwiftShader is not a real GPU).
 *
 * Two-phase handshake (same pattern as webgpu-probe):
 *   phase 1 → report.status = "ready"; spec reads metrics + calls finish();
 *   phase 2 → unload checks → "done".
 */
import {
  AssetCache,
  createResolverAssetLoader,
  type SceneDocument,
} from "@your-scope/scene-editor";
import { ThreeRuntime } from "@your-scope/scene-editor/three";

interface FrameStats {
  samples: number;
  dropped: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface RendererInfoSnapshot {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
}

interface UnloadCheck {
  sceneChildrenBaseline: number;
  sceneChildrenAfter: number;
  geometriesBaseline: number;
  geometriesAfter: number;
  texturesBaseline: number;
  texturesAfter: number;
  objectsGone: boolean;
  heapUsedBeforeLoad: number | null;
  heapUsedAfterUnload: number | null;
}

interface PerfReport {
  status: "running" | "ready" | "done" | "failed";
  timestamp: string;
  userAgent: string;
  objectCount: number;
  framesRequested: number;
  firstInteractiveMs: number | null;
  sceneLoadMs: number | null;
  frameStats: FrameStats | null;
  infoBaseline: RendererInfoSnapshot | null;
  infoAfterLoad: RendererInfoSnapshot | null;
  infoAfterUnload: RendererInfoSnapshot | null;
  unload: UnloadCheck | null;
  errors: string[];
}

interface PerfApi {
  report: PerfReport;
  finish: () => Promise<void>;
}

declare global {
  interface Window {
    __perfBench: PerfApi;
  }
}

const params = new URLSearchParams(location.search);
const OBJECT_COUNT = clampInt(params.get("objects"), 1000, 1, 20000);
const FRAME_COUNT = clampInt(params.get("frames"), 60, 10, 600);

const report: PerfReport = {
  status: "running",
  timestamp: new Date().toISOString(),
  userAgent: navigator.userAgent,
  objectCount: OBJECT_COUNT,
  framesRequested: FRAME_COUNT,
  firstInteractiveMs: null,
  sceneLoadMs: null,
  frameStats: null,
  infoBaseline: null,
  infoAfterLoad: null,
  infoAfterUnload: null,
  unload: null,
  errors: [],
};

let runtime: ThreeRuntime | null = null;
let finished = false;
let heapBeforeLoad: number | null = null;

window.__perfBench = {
  report,
  finish: async () => {
    if (finished || runtime == null) return;
    finished = true;
    try {
      const sceneChildrenBaseline = 3; // ambient + directional + grid
      runtime.flushDisposers();
      const infoAfter = readInfo(runtime);
      const sampleIds = ["obj-0", `obj-${OBJECT_COUNT - 1}`];
      const objectsGone = sampleIds.every((id) => runtime!.getObjectById(id) === undefined);
      const perfMemory = (
        performance as unknown as { memory?: { usedJSHeapSize: number } }
      ).memory;
      report.unload = {
        sceneChildrenBaseline,
        sceneChildrenAfter: runtime.scene.children.length,
        geometriesBaseline: report.infoBaseline?.geometries ?? -1,
        geometriesAfter: infoAfter?.geometries ?? -1,
        texturesBaseline: report.infoBaseline?.textures ?? -1,
        texturesAfter: infoAfter?.textures ?? -1,
        objectsGone,
        heapUsedBeforeLoad: heapBeforeLoad,
        heapUsedAfterUnload: perfMemory?.usedJSHeapSize ?? null,
      };
      report.infoAfterUnload = infoAfter;
    } catch (err) {
      report.errors.push(`finish: ${String(err)}`);
    }
    report.status = report.errors.length > 0 ? "failed" : "done";
  },
};

window.addEventListener("error", (e) => report.errors.push(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  report.errors.push(`unhandledrejection: ${String(e.reason)}`),
);

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function readInfo(rt: ThreeRuntime): RendererInfoSnapshot | null {
  const info = (rt.renderer as unknown as {
    info?: {
      render?: { calls?: number; triangles?: number };
      memory?: { geometries?: number; textures?: number };
      programs?: { length?: number };
    };
  }).info;
  if (!info) return null;
  return {
    drawCalls: info.render?.calls ?? -1,
    triangles: info.render?.triangles ?? -1,
    geometries: info.memory?.geometries ?? -1,
    textures: info.memory?.textures ?? -1,
    programs: info.programs?.length ?? -1,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -1;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? -1;
}

function buildDoc(count: number): SceneDocument {
  const objects = Array.from({ length: count }, (_, i) => {
    const col = i % 40;
    const row = Math.floor(i / 40);
    return {
      id: `obj-${i}`,
      type: "mesh" as const,
      name: `Box ${i}`,
      position: [(col - 20) * 1.5, 0.5, (row - 12) * 1.5] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
  });
  return {
    schemaVersion: 1,
    sceneId: "perf-bench",
    revision: 0,
    objects,
  };
}

function sampleFrames(rt: ThreeRuntime, count: number): Promise<FrameStats> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = performance.now();
    let i = 0;
    const tick = (): void => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      rt.render();
      i += 1;
      if (i >= count) {
        // drop warmup deltas (shader compile, JIT, rAF alignment) — 5 frames
        const dropped = Math.min(5, deltas.length);
        const settled = deltas.slice(dropped).sort((a, b) => a - b);
        resolve({
          samples: settled.length,
          dropped,
          p50Ms: percentile(settled, 50),
          p95Ms: percentile(settled, 95),
          maxMs: settled.length > 0 ? (settled[settled.length - 1] ?? -1) : -1,
        });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function run(): Promise<void> {
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const perfMemory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  heapBeforeLoad = perfMemory?.usedJSHeapSize ?? null;

  performance.mark("perf:bench-start");
  runtime = new ThreeRuntime({
    canvas,
    assetCache: new AssetCache(
      createResolverAssetLoader({
        resolver: {
          resolve: async (assetId: string) => {
            throw new Error(`perf bench has no external assets: ${assetId}`);
          },
        },
      }),
    ),
  });

  // baseline AFTER controls mount (gizmo has its own geometries) + one render
  await runtime.controlsReady;
  // pull camera back so the whole 40×25 grid stays in frustum (no cull understatement)
  runtime.camera.position.set(0, 45, 75);
  runtime.camera.lookAt(0, 0, 0);
  runtime.camera.updateProjectionMatrix();
  runtime.render();
  report.infoBaseline = readInfo(runtime);

  performance.mark("perf:load-start");
  await runtime.loadDocument(buildDoc(OBJECT_COUNT));
  performance.mark("perf:load-end");
  performance.measure("perf:scene-load", "perf:load-start", "perf:load-end");
  const loadMeasure = performance.getEntriesByName("perf:scene-load").at(-1);
  report.sceneLoadMs = loadMeasure?.duration ?? null;
  report.infoAfterLoad = readInfo(runtime);

  // first-interactive = document loaded + gizmo ready + frame actually on screen
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  performance.mark("perf:interactive");
  report.firstInteractiveMs = performance.now();

  report.frameStats = await sampleFrames(runtime, FRAME_COUNT);
  report.status = report.errors.length > 0 ? "failed" : "ready";
}

void run().catch((err) => {
  report.errors.push(`run: ${err instanceof Error && err.stack ? err.stack : String(err)}`);
  report.status = "failed";
});
