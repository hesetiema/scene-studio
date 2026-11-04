/**
 * Demo: assets — the host owns URLs, the SDK owns resolution + caching.
 *
 * Two independent surfaces:
 *   1. `element.assetResolver` + GLB instantiation through the default
 *      ThreeRuntime (needs WebGL, runs in the viewport).
 *   2. `AssetCache` refcounting (pure logic, no GPU) — parallel retains collapse,
 *      dispose fires only on the last release, next retain reloads.
 */
import * as THREE from "three";
import {
  AssetCache,
  SUPPORTED_ASSET_FORMATS,
  type SceneDocument,
} from "@scenio/scene-editor";
import { defineSceneEditor, type SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";
import { createLog, q, setFields } from "./shared";

interface AssetErrorDetail {
  code: string;
  message: string;
}

interface AssetsHook {
  state: () => {
    loaded: boolean;
    sceneId: string;
    resolved: string[];
    errors: AssetErrorDetail[];
    meshCount: number;
    objectCount: number;
  };
  actions: {
    loadTri: () => Promise<{ ok: boolean; code?: string }>;
    loadMissing: () => Promise<{ ok: boolean; code?: string }>;
    loadUnsupported: () => Promise<{ ok: boolean; code?: string }>;
    runCache: () => Promise<Record<string, unknown>>;
  };
  /** Fixture builder for adversarial/race tests (no button drives this). */
  makeDoc: (assetId: string, sceneId?: string) => SceneDocument;
}

declare global {
  interface Window {
    __assets: AssetsHook;
  }
}

const log = createLog();
const statusEl = q("#status");
const outputEl = q<HTMLPreElement>("#output");

let editor: SceneEditorElement | null = null;
let loaded = false;
const resolved: string[] = [];
const errors: AssetErrorDetail[] = [];

q("#formats").textContent = SUPPORTED_ASSET_FORMATS.join(" / ");

/** Known ids → URLs. Unknown ids are rejected, including path-traversal ones. */
const KNOWN_ASSETS: Record<string, string> = {
  tri: "/assets/tri.glb",
  legacy: "/assets/legacy.obj", // deliberately unsupported → asset-unsupported-format
};

function assetDoc(assetId: string, sceneId = `asset-${assetId}`): SceneDocument {
  return {
    schemaVersion: 2,
    sceneId,
    revision: 0,
    objects: [
      {
        id: `${assetId}-object`,
        type: "mesh",
        name: `Asset ${assetId}`,
        assetId,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    view: {
      camera: { position: [3, 2, 4], target: [0, 0.5, 0], fov: 45 },
      lights: {
        ambient: { color: "#ffffff", intensity: 0.6 },
        directional: { color: "#eef6ff", intensity: 1.2, position: [5, 10, 7] },
      },
      environment: { background: "#0b0f19", gridVisible: true },
    },
  };
}

/** Mesh count = tagged objects in the scene graph (proves the asset materialized). */
function countMeshes(): number {
  if (!editor) return 0;
  const rt = editor.runtime as ThreeRuntime;
  let count = 0;
  rt.scene.traverse((object) => {
    if (typeof object.userData?.sceneObjectId === "string") count += 1;
  });
  return count;
}

/** Frame whatever the document mounted — assets have arbitrary scales. */
function frameScene(): void {
  if (!editor) return;
  const rt = editor.runtime as ThreeRuntime;
  const box = new THREE.Box3();
  const roots: THREE.Object3D[] = [];
  rt.scene.traverse((object) => {
    const tagged = typeof object.userData?.sceneObjectId === "string";
    const parentTagged = typeof object.parent?.userData?.sceneObjectId === "string";
    if (tagged && !parentTagged) roots.push(object);
  });
  for (const root of roots) box.expandByObject(root);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.001);
  const view = editor.getViewState();
  editor.setViewState({
    ...view,
    camera: {
      position: [center.x + radius * 1.8, center.y + radius * 1.2, center.z + radius * 2.4],
      target: [center.x, center.y, center.z],
      fov: 45,
    },
  });
}

/** `getDocument()` throws before the first load — hosts should guard it. */
function currentDoc(): SceneDocument | null {
  if (!editor) return null;
  try {
    return editor.getDocument();
  } catch {
    return null;
  }
}

function renderStatus(): void {
  if (!editor) return;
  const doc = currentDoc();
  setFields(statusEl, [
    ["loaded", loaded],
    ["sceneId", doc?.sceneId ?? "-"],
    ["objects", doc?.objects.length ?? 0],
    ["sceneNodes", countMeshes()],
    ["resolved", resolved.join(", ") || "-"],
    ["errors", errors.length],
  ]);
}

async function load(
  assetId: string,
  sceneId?: string,
): Promise<{ ok: boolean; code?: string }> {
  if (!editor) return { ok: false, code: "lifecycle" };
  const errorsBefore = errors.length;
  await editor.loadDocument(assetDoc(assetId, sceneId));
  const newErrors = errors.slice(errorsBefore);
  if (newErrors.length > 0) {
    renderStatus();
    const code = newErrors[newErrors.length - 1]!.code;
    log.err(`loadDocument 完成但资产失败：${code}`);
    return { ok: false, code };
  }
  loaded = true;
  frameScene();
  renderStatus();
  log.ok(`资产已实例化：${assetId} · sceneNodes=${countMeshes()}`);
  return { ok: true };
}

async function runCacheDemo(): Promise<Record<string, unknown>> {
  let loads = 0;
  let disposes = 0;
  const cache = new AssetCache(async (assetId) => {
    loads += 1;
    log(`cache loader(${assetId}) → 第 ${loads} 次真实加载`);
    return {
      scene: { assetId },
      dispose: () => {
        disposes += 1;
      },
    };
  });

  const first = await cache.retain("tri");
  const second = await cache.retain("tri");
  const collapsedRefs = cache.refCount("tri");
  const collapsedLoads = loads;

  cache.release("tri");
  const afterFirstRelease = { refs: cache.refCount("tri"), disposes };
  cache.release("tri");
  const afterLastRelease = { refs: cache.refCount("tri"), disposes };

  const reloaded = await cache.retain("tri");
  const result = {
    sameInstance: first === second,
    collapsedRefs,
    collapsedLoads,
    afterFirstRelease,
    afterLastRelease,
    reloadedNewInstance: reloaded !== first,
    totalLoads: loads,
    totalDisposes: disposes,
  };
  outputEl.textContent = JSON.stringify(result, null, 2);
  log.ok(
    `AssetCache：${collapsedLoads} 次加载服务 ${collapsedRefs} 个引用；归零后 dispose=${afterLastRelease.disposes}；再 retain 重新加载`,
  );
  return result;
}

async function main(): Promise<void> {
  defineSceneEditor();

  // The element reads `assetResolver` during connect — set it before appending.
  const el = document.createElement("scene-editor") as SceneEditorElement;
  el.style.width = "100%";
  el.style.height = "100%";
  // Allowlist, not string concatenation: the resolver is the host's trust
  // boundary (a document must not be able to point the page at arbitrary URLs).
  el.assetResolver = {
    async resolve(assetId: string): Promise<string> {
      resolved.push(assetId);
      log(`resolver.resolve("${assetId}")`);
      const url = KNOWN_ASSETS[assetId];
      if (!url) {
        throw new Error(`unknown asset id: ${assetId}`);
      }
      return url;
    },
  };
  el.addEventListener("error", (event) => {
    const detail = (event as unknown as CustomEvent<AssetErrorDetail>).detail;
    errors.push(detail);
    log.err(`[${detail.code}] ${detail.message}`);
    renderStatus();
  });

  q("#stage").appendChild(el);
  editor = el;
  await el.ready;

  const loadButtons = ["#load-tri", "#load-missing", "#load-unsupported"].map((selector) =>
    q<HTMLButtonElement>(selector),
  );
  const uiLoad = async (assetId: string): Promise<void> => {
    // UI guard only: the SDK serializes loads too, this just keeps the demo
    // honest about which row the status bar is describing.
    for (const button of loadButtons) button.disabled = true;
    try {
      await load(assetId);
    } finally {
      for (const button of loadButtons) button.disabled = false;
    }
  };

  q("#load-tri").addEventListener("click", () => void uiLoad("tri"));
  q("#load-missing").addEventListener("click", () => void uiLoad("missing"));
  q("#load-unsupported").addEventListener("click", () => void uiLoad("legacy"));
  q("#run-cache").addEventListener("click", () => void runCacheDemo());

  document.body.dataset.demo = "ready";
  window.__assets = {
    state: () => {
      const doc = currentDoc();
      return {
        loaded,
        sceneId: doc?.sceneId ?? "",
        resolved: [...resolved],
        errors: [...errors],
        meshCount: countMeshes(),
        objectCount: doc?.objects.length ?? 0,
      };
    },
    actions: {
      loadTri: () => load("tri"),
      loadMissing: () => load("missing"),
      loadUnsupported: () => load("legacy"),
      runCache: runCacheDemo,
    },
    makeDoc: (assetId: string, sceneId?: string) => assetDoc(assetId, sceneId),
  };
  log.ok("ready · 先点“加载 /assets/tri.glb”，再试缺失资产与引用计数");
}

void main().catch((error: unknown) => {
  statusEl.textContent = `初始化失败：${error instanceof Error ? error.message : String(error)}`;
  log.err(`fatal: ${String(error)}`);
});
