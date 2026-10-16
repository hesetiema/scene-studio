import {
  defineSceneEditor,
  SceneEditorElement,
} from "@scenio/scene-editor/element";
import {
  DEFAULT_VIEW_STATE,
  type SceneDocument,
  inspectModel,
} from "@scenio/scene-editor";
import {
  ThreeRuntime,
  createSelectionHighlightPlugin,
} from "@scenio/scene-editor/three";
import * as THREE from "three";
import { CameraController } from "./camera/camera-controller";
import { ModelLoader } from "./assets/model-loader";
import { HUDController } from "./ui/hud-controller";
import { mechaAssemblyDoc, defaultMultiDoc } from "./bootstrap";

// Model loader (P1: decoupled from main.ts)
const modelLoader = new ModelLoader();
const assetCache = modelLoader.getAssetCache();

let runtimeInstance: ThreeRuntime | null = null;

// Register runtime factory BEFORE defineSceneEditor upgrades the element!
SceneEditorElement.runtimeFactory = (canvas) => {
  const rt = new ThreeRuntime({ canvas, assetCache });
  runtimeInstance = rt;
  window.__runtime = rt;
  return rt;
};

// Define custom element (upgrades existing <scene-editor> in DOM)
defineSceneEditor();

const el = document.querySelector("scene-editor") as SceneEditorElement;

// Camera controller (P0: decoupled from main.ts)
const camera = new CameraController(
  el,
  () => runtimeInstance ?? (el.runtime as ThreeRuntime),
);
// HUD controller (P2: decoupled from main.ts)
const hud = new HUDController(
  el,
  () => runtimeInstance ?? (el.runtime as ThreeRuntime),
);

/** In-memory host store for e2e save/conflict flows (D18/D17). */
const host = {
  serverDoc: structuredClone(mechaAssemblyDoc),
  forceConflict: false,
  saves: 0,
};

// Test hooks on window
declare global {
  interface Window {
    __editor: SceneEditorElement;
    __host: typeof host;
    __savedDocs: SceneDocument[];
    __conflicts: unknown[];
    __runtime?: ThreeRuntime;
    loadCustomModel: (urlOrFile: string | File, name?: string) => Promise<void>;
  }
}
window.__editor = el;
window.__host = host;
window.__savedDocs = [];
window.__conflicts = [];

// Save flow
el.addEventListener("save-request", async () => {
  const local = el.getDocument();
  if (host.forceConflict) {
    const incoming: SceneDocument = {
      ...host.serverDoc,
      revision: host.serverDoc.revision + 1,
    };
    const conflict = { base: { ...host.serverDoc }, incoming, local };
    window.__conflicts.push(conflict);
    el.dispatchEvent(new CustomEvent("save-conflict", { detail: conflict }));
    host.forceConflict = false;
    return;
  }
  if (local.revision !== host.serverDoc.revision) {
    const incoming = host.serverDoc;
    const conflict = {
      base: { ...host.serverDoc, revision: local.revision },
      incoming,
      local,
    };
    window.__conflicts.push(conflict);
    el.dispatchEvent(new CustomEvent("save-conflict", { detail: conflict }));
    return;
  }
  host.saves += 1;
  const next: SceneDocument = { ...local, revision: local.revision + 1 };
  host.serverDoc = structuredClone(next);
  window.__savedDocs.push(structuredClone(next));
  el.markSaved(next.revision);
  hud.showToast(`Saved Revision ${next.revision}`);
  hud.updateDirtyUI();
});

el.addEventListener("save-conflict", () => {
  document.body.dataset.conflict = "true";
  hud.showToast("Save conflict detected!");
});

el.addEventListener("history-change", () => {
  hud.updateDirtyUI();
});

el.addEventListener("selection-change", () => {
  hud.updateSelectionUI();
});

function updateDirtyUI(): void {
  const revEl = document.querySelector("#rev-val");
  const dirtyEl = document.querySelector("#dirty-val");
  const objCountEl = document.querySelector("#obj-count-val");

  if (revEl) revEl.textContent = String(el.revision);
  if (dirtyEl) {
    dirtyEl.textContent = el.dirty ? "MODIFIED" : "CLEAN";
    (dirtyEl as HTMLElement).style.color = el.dirty ? "#ffab40" : "#38e2ff";
  }
  if (objCountEl) {
    objCountEl.textContent = String(el.getDocument().objects.length);
  }
}

function showToast(msg: string): void {
  const toast = document.querySelector("#toast") as HTMLElement | null;
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2500);
}

// Shading / Display Modes
let currentViewMode: "studio" | "xray" | "wireframe" | "normal" | "clay" =
  "studio";
const origMaterials = new WeakMap<
  THREE.Mesh,
  THREE.Material | THREE.Material[]
>();

function applyViewMode(
  mode: "studio" | "xray" | "wireframe" | "normal" | "clay",
): void {
  currentViewMode = mode;
  const rt = runtimeInstance || (el.runtime as ThreeRuntime);
  if (!rt) return;

  rt.scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (!origMaterials.has(mesh)) {
        origMaterials.set(mesh, mesh.material);
      }
      const orig = origMaterials.get(mesh)!;

      if (mode === "studio") {
        mesh.material = orig;
      } else if (mode === "xray") {
        mesh.material = new THREE.MeshPhysicalMaterial({
          color: 0x0a2233,
          transmission: 0.9,
          opacity: 0.75,
          transparent: true,
          roughness: 0.12,
          metalness: 0.15,
          ior: 1.45,
          emissive: 0x05425c,
          emissiveIntensity: 0.5,
          wireframe: false,
        });
      } else if (mode === "wireframe") {
        mesh.material = new THREE.MeshStandardMaterial({
          color: 0x38e2ff,
          wireframe: true,
          roughness: 0.5,
        });
      } else if (mode === "normal") {
        mesh.material = new THREE.MeshNormalMaterial();
      } else if (mode === "clay") {
        mesh.material = new THREE.MeshStandardMaterial({
          color: 0xd0d4dc,
          roughness: 0.65,
          metalness: 0.05,
        });
      }
    }
  });

  rt.render?.();

  document.querySelectorAll(".mode-tab[data-mode]").forEach((tab) => {
    tab.classList.toggle("active", (tab as HTMLElement).dataset.mode === mode);
  });
}

// Explode view implementation
const origPositions = new WeakMap<THREE.Object3D, THREE.Vector3>();

function applyExplode(factor: number): void {
  const rt = runtimeInstance || (el.runtime as ThreeRuntime);
  if (!rt) return;

  const currentDoc = el.getDocument();
  const objects3d: THREE.Object3D[] = [];

  for (const objDto of currentDoc.objects) {
    const o3d = rt.getObjectById(objDto.id);
    if (o3d) objects3d.push(o3d);
  }

  if (objects3d.length === 0) return;

  // Compute aggregate center
  const totalBox = new THREE.Box3();
  for (const o of objects3d) totalBox.expandByObject(o);
  const center = totalBox.getCenter(new THREE.Vector3());

  // Multi-object scene explosion
  if (objects3d.length > 1) {
    for (const root of objects3d) {
      if (!origPositions.has(root)) {
        origPositions.set(root, root.position.clone());
      }
      const origPos = origPositions.get(root)!;

      // Special directional vectors for humanoid mecha assembly
      if (root.userData.objectId === "part-head") {
        root.position.copy(origPos).add(new THREE.Vector3(0, factor * 0.7, 0));
      } else if (root.userData.objectId === "part-shells") {
        root.position.copy(origPos).add(new THREE.Vector3(0, 0, factor * 0.5));
      } else {
        root.position.copy(origPos);
      }

      // Also explode inner sub-meshes outward
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh && child !== root) {
          if (!origPositions.has(child)) {
            origPositions.set(child, child.position.clone());
          }
          const origP = origPositions.get(child)!;
          const worldP = child.getWorldPosition(new THREE.Vector3());
          const dir = worldP.clone().sub(center).normalize();
          child.position.copy(origP).addScaledVector(dir, factor * 0.6);
        }
      });
    }
  } else {
    // Single object explosion: explode its sub-meshes outward
    const root = objects3d[0]!;
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child !== root) {
        if (!origPositions.has(child)) {
          origPositions.set(child, child.position.clone());
        }
        const origPos = origPositions.get(child)!;
        const worldPos = child.getWorldPosition(new THREE.Vector3());
        const dir = worldPos.clone().sub(center).normalize();
        child.position.copy(origPos).addScaledVector(dir, factor * 0.8);
      }
    });
  }

  rt.render?.();
}

// Live Model Telemetry calculation
function updateTelemetry(name: string, format: string): void {
  const nameEl = document.querySelector("#stat-name");
  const formatEl = document.querySelector("#stat-format");
  const meshEl = document.querySelector("#stat-meshes");
  const polyEl = document.querySelector("#stat-polys");
  const vertEl = document.querySelector("#stat-verts");
  const boundEl = document.querySelector("#stat-bounds");

  if (nameEl) nameEl.textContent = name;
  if (formatEl) formatEl.textContent = format.toUpperCase();

  const rt = runtimeInstance || (el.runtime as ThreeRuntime);
  if (!rt) return;

  const currentDoc = el.getDocument();
  let totalMeshes = 0;
  let totalTris = 0;
  let totalVerts = 0;
  const overallBox = new THREE.Box3();

  for (const objDto of currentDoc.objects) {
    const obj3d = rt.getObjectById(objDto.id);
    if (obj3d) {
      const meta = inspectModel(obj3d);
      totalMeshes += meta.meshCount;
      totalTris += meta.triangleCount;
      totalVerts += meta.vertexCount;
      overallBox.expandByObject(obj3d);
    }
  }

  const size = overallBox.getSize(new THREE.Vector3());

  if (meshEl) meshEl.textContent = totalMeshes.toLocaleString();
  if (polyEl) polyEl.textContent = totalTris.toLocaleString();
  if (vertEl) vertEl.textContent = totalVerts.toLocaleString();
  if (boundEl) {
    boundEl.textContent = `${size.x.toFixed(2)} 脳 ${size.y.toFixed(2)} 脳 ${size.z.toFixed(2)}m`;
  }
}

// Selected Object Inspector UI update
function updateSelectionUI(): void {
  const idEl = document.querySelector("#inspect-id");
  const posEl = document.querySelector("#inspect-pos");
  const rotEl = document.querySelector("#inspect-rot");

  const selectedId = el.selectedIds[0];
  if (!selectedId) {
    if (idEl) idEl.textContent = "None (Click mesh)";
    if (posEl) posEl.textContent = "[0.0, 0.0, 0.0]";
    if (rotEl) rotEl.textContent = "[0.0掳, 0.0掳, 0.0掳]";
    return;
  }

  const doc = el.getDocument();
  const obj = doc.objects.find((o) => o.id === selectedId);
  if (!obj) return;

  if (idEl) idEl.textContent = obj.name || obj.id;
  if (posEl) {
    posEl.textContent = `[${obj.position[0].toFixed(2)}, ${obj.position[1].toFixed(2)}, ${obj.position[2].toFixed(2)}]`;
  }
  if (rotEl) {
    const degX = ((obj.rotation[0] * 180) / Math.PI).toFixed(0);
    const degY = ((obj.rotation[1] * 180) / Math.PI).toFixed(0);
    const degZ = ((obj.rotation[2] * 180) / Math.PI).toFixed(0);
    rotEl.textContent = `[${degX}掳, ${degY}掳, ${degZ}掳]`;
  }
}

// Smooth camera animation helper (prevents flashing and sudden jumps)

// Universal Model Loader helper (for file picker, drag & drop, URL)
async function loadCustomModel(
  urlOrFile: string | File,
  customName?: string,
): Promise<void> {
  const { doc, filename, format } = await modelLoader.createCustomModelDoc(
    urlOrFile,
    customName,
  );
  await el.loadDocument(doc);
  host.serverDoc = structuredClone(doc);
  updateDirtyUI();
  hud.updateTelemetry(filename, format);
  hud.showToast(`Loaded ${filename}`);
  camera.frameScene(false);
}

window.loadCustomModel = loadCustomModel;

// Load predefined models by dropdown value (Instant, smooth, zero flash!)
async function loadModelByOption(value: string): Promise<void> {
  const preset = modelLoader.createModelDocByOption(value);
  if (!preset) return;

  await el.loadDocument(preset.doc);
  host.serverDoc = structuredClone(preset.doc);
  hud.updateTelemetry(preset.telemetryName, preset.telemetryFormat);
  hud.updateDirtyUI();
  camera.frameScene(false);
}

// Live FPS & Latency Counter
function initFpsCounter(): void {
  hud.startFpsCounter();

  // Camera Presets: Uniform, comfortable scale across all view angles
  function setCameraPreset(
    preset: "iso" | "top" | "front" | "side",
    smooth = true,
  ): void {
    camera.setCameraPreset(preset, smooth);

    const { distance } = camera.getBoundingInfo();
    const camStatEl = document.querySelector("#hud-cam-stat");
    if (camStatEl) {
      camStatEl.textContent = `CAM: ${preset.toUpperCase()} 路 DIST: ${distance.toFixed(1)}m`;
    }

    document
      .querySelectorAll("#cam-iso, #cam-top, #cam-front, #cam-side")
      .forEach((btn) => {
        btn.classList.toggle("active", btn.id === `cam-${preset}`);
      });
    showToast(`Camera: ${preset.toUpperCase()}`);
  }

  // Lighting Presets
  function applyLightPreset(
    preset: "studio" | "cyber" | "sunset" | "contrast",
  ): void {
    const curView = el.getViewState();
    let ambient = { color: "#ffffff", intensity: 0.65 };
    let directional = {
      color: "#eef6ff",
      intensity: 1.35,
      position: [5, 10, 7] as [number, number, number],
    };

    if (preset === "studio") {
      ambient = { color: "#ffffff", intensity: 0.65 };
      directional = {
        color: "#eef6ff",
        intensity: 1.35,
        position: [5, 10, 7] as [number, number, number],
      };
    } else if (preset === "cyber") {
      ambient = { color: "#0a2233", intensity: 0.6 };
      directional = {
        color: "#38e2ff",
        intensity: 1.8,
        position: [6, 8, 5] as [number, number, number],
      };
    } else if (preset === "sunset") {
      ambient = { color: "#2d1a0e", intensity: 0.5 };
      directional = {
        color: "#ff9d42",
        intensity: 1.6,
        position: [-8, 6, 7] as [number, number, number],
      };
    } else if (preset === "contrast") {
      ambient = { color: "#0c0d10", intensity: 0.25 };
      directional = {
        color: "#ffffff",
        intensity: 2.2,
        position: [0, 12, 4] as [number, number, number],
      };
    }

    el.setViewState({
      ...curView,
      lights: { ambient, directional },
    });

    document.querySelectorAll(".light-preset-btn").forEach((btn) => {
      btn.classList.toggle(
        "active",
        (btn as HTMLElement).dataset.light === preset,
      );
    });
    showToast(`Light: ${preset.toUpperCase()}`);
  }

  // Snapshot Capture
  function captureSnapshot(): void {
    const canvas = el.querySelector("canvas");
    if (!canvas) return;
    const rt = runtimeInstance || (el.runtime as ThreeRuntime);
    rt?.render?.();
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `scene-studio-${Date.now()}.png`;
    a.click();
    showToast("Snapshot Exported");
  }

  // Setup User Interface
  function setupUI(): void {
    // Model selector dropdown
    const modelSelect = document.querySelector(
      "#model-select",
    ) as HTMLSelectElement | null;
    modelSelect?.addEventListener("change", async (e) => {
      const val = (e.target as HTMLSelectElement).value;
      await loadModelByOption(val);
    });

    // Upload button & File input
    const btnUpload = document.querySelector("#btn-upload");
    const fileInput = document.querySelector(
      "#file-input",
    ) as HTMLInputElement | null;
    btnUpload?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        void loadCustomModel(file);
      }
    });

    // URL button
    const btnUrl = document.querySelector("#btn-url");
    btnUrl?.addEventListener("click", () => {
      const url = prompt(
        "Enter 3D model URL (.glb, .gltf, .obj, .stl):",
        "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF-Binary/DamagedHelmet.glb",
      );
      if (url) {
        void loadCustomModel(url);
      }
    });

    // View modes
    document.querySelectorAll(".mode-tab[data-mode]").forEach((tab) => {
      tab.addEventListener("click", () => {
        const mode = (tab as HTMLElement).dataset.mode as
          | "studio"
          | "xray"
          | "wireframe"
          | "normal"
          | "clay";
        applyViewMode(mode);
      });
    });

    // Explode slider
    const explodeSlider = document.querySelector(
      "#explode-slider",
    ) as HTMLInputElement | null;
    const explodeVal = document.querySelector("#explode-val");
    explodeSlider?.addEventListener("input", (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      if (explodeVal) explodeVal.textContent = `${val}%`;
      applyExplode(val / 100);
    });

    // Frame button (smooth animation)
    document.querySelector("#btn-frame")?.addEventListener("click", () => {
      camera.frameScene(true);
    });

    // Reset Camera button (smooth home)
    document.querySelector("#btn-reset-cam")?.addEventListener("click", () => {
      camera.resetCamera(true);
      showToast("Camera Reset [H]");
    });

    // Save button
    document.querySelector("#btn-save")?.addEventListener("click", () => {
      el.requestSave();
    });

    // Turntable button
    document.querySelector("#btn-turntable")?.addEventListener("click", () => {
      const active = camera.toggleTurntable();
      document
        .querySelector("#btn-turntable")
        ?.classList.toggle("active", active);
    });

    // Snapshot button
    document
      .querySelector("#btn-snapshot")
      ?.addEventListener("click", captureSnapshot);

    // Gizmo modes (Translate, Rotate, Scale, None)
    const setGizmoMode = (mode: "translate" | "rotate" | "scale" | "none") => {
      if (mode === "none") {
        el.clearSelection();
      } else {
        const key = mode === "translate" ? "g" : mode === "rotate" ? "r" : "s";
        el.dispatchEvent(new KeyboardEvent("keydown", { key }));
      }

      document
        .querySelectorAll("#gizmo-t, #gizmo-r, #gizmo-s, #gizmo-none")
        .forEach((btn) => {
          btn.classList.remove("active");
        });
      if (mode === "translate")
        document.querySelector("#gizmo-t")?.classList.add("active");
      if (mode === "rotate")
        document.querySelector("#gizmo-r")?.classList.add("active");
      if (mode === "scale")
        document.querySelector("#gizmo-s")?.classList.add("active");
      if (mode === "none")
        document.querySelector("#gizmo-none")?.classList.add("active");
    };

    document
      .querySelector("#gizmo-t")
      ?.addEventListener("click", () => setGizmoMode("translate"));
    document
      .querySelector("#gizmo-r")
      ?.addEventListener("click", () => setGizmoMode("rotate"));
    document
      .querySelector("#gizmo-s")
      ?.addEventListener("click", () => setGizmoMode("scale"));
    document
      .querySelector("#gizmo-none")
      ?.addEventListener("click", () => setGizmoMode("none"));

    // Camera presets
    document
      .querySelector("#cam-iso")
      ?.addEventListener("click", () => setCameraPreset("iso"));
    document
      .querySelector("#cam-top")
      ?.addEventListener("click", () => setCameraPreset("top"));
    document
      .querySelector("#cam-front")
      ?.addEventListener("click", () => setCameraPreset("front"));
    document
      .querySelector("#cam-side")
      ?.addEventListener("click", () => setCameraPreset("side"));

    // Floor Grid Toggle
    const toggleGridBtn = document.querySelector("#toggle-grid");
    toggleGridBtn?.addEventListener("click", () => {
      const cur = el.getViewState();
      const nextVis = !cur.environment.gridVisible;
      el.setViewState({
        ...cur,
        environment: { ...cur.environment, gridVisible: nextVis },
      });
      toggleGridBtn.classList.toggle("active", nextVis);
      toggleGridBtn.textContent = nextVis
        ? "Floor Grid: ON"
        : "Floor Grid: OFF";
      showToast(`Grid: ${nextVis ? "Visible" : "Hidden"}`);
    });

    // Backdrop Theme Presets (Instant clear visual feedback!)
    document.querySelectorAll(".bg-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const hex = (btn as HTMLElement).dataset.bg || "#0c0e12";
        const name = (btn as HTMLElement).textContent?.trim() || hex;

        const curView = el.getViewState();
        el.setViewState({
          ...curView,
          environment: {
            ...curView.environment,
            background: hex,
          },
        });

        // Update body and viewport background directly
        document.body.style.backgroundColor = hex;
        el.style.backgroundColor = hex;
        const rt = runtimeInstance || (el.runtime as ThreeRuntime);
        if (rt) {
          rt.scene.background = new THREE.Color(hex);
          rt.render?.();
        }

        // Highlight active button
        document.querySelectorAll(".bg-preset-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
        });

        showToast(`Backdrop: ${name}`);
      });
    });

    // Lighting presets
    document.querySelectorAll(".light-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = (btn as HTMLElement).dataset.light as
          | "studio"
          | "cyber"
          | "sunset"
          | "contrast";
        applyLightPreset(p);
      });
    });

    // Undo / Redo buttons
    document
      .querySelector("#btn-undo")
      ?.addEventListener("click", () => el.undo());
    document
      .querySelector("#btn-redo")
      ?.addEventListener("click", () => el.redo());

    // Global Keyboard Hotkeys
    window.addEventListener("keydown", (e) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      if (e.key === "1") applyViewMode("studio");
      if (e.key === "2") applyViewMode("xray");
      if (e.key === "3") applyViewMode("wireframe");
      if (e.key === "4") applyViewMode("normal");
      if (e.key === "5") applyViewMode("clay");
      if (e.key === "f" || e.key === "F") camera.frameScene(true);
      if (e.key === "h" || e.key === "H") {
        camera.resetCamera(true);
        showToast("Camera Reset [H]");
      }
      if (e.code === "Space") {
        e.preventDefault();
        const active = camera.toggleTurntable();
        document
          .querySelector("#btn-turntable")
          ?.classList.toggle("active", active);
      }
      if (e.key === "7") camera.setCameraPreset("top");
    });

    // Drag & drop 3D files directly over viewport
    const dropOverlay = document.querySelector("#drop-overlay");
    let dragCounter = 0;

    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragCounter++;
      dropOverlay?.classList.add("visible");
    });

    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropOverlay?.classList.remove("visible");
      }
    });

    window.addEventListener("dragover", (e) => {
      e.preventDefault();
    });

    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragCounter = 0;
      dropOverlay?.classList.remove("visible");

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0]!;
        void loadCustomModel(file);
      }
    });

    initFpsCounter();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupUI);
  } else {
    setupUI();
  }

  // Stage-3 plugin demo: selection highlight
  el.use(createSelectionHighlightPlugin());

  // Boot sequence
  document.body.dataset.boot = "pending";

  void el.ready.then(async () => {
    // Check if test query parameter is present (like /?select=box-1 for e2e screenshots)
    const params = new URLSearchParams(location.search);
    const selectId = params.get("select");

    if (selectId || location.search.includes("select=")) {
      // E2E test mode: load defaultMultiDoc
      await el.loadDocument(defaultMultiDoc);
      host.serverDoc = structuredClone(defaultMultiDoc);
      hud.updateTelemetry("Geometric Unit Assembly", "Default Scene");
    } else {
      // Standard mode: load complete mecha assembly figure directly in pre-framed view
      await el.loadDocument(mechaAssemblyDoc);
      host.serverDoc = structuredClone(mechaAssemblyDoc);
      hud.updateTelemetry("Complete Mecha Assembly", "GLTF / GLB (Multi-Part)");
    }

    if (selectId) {
      el.selectObject(selectId);
    }

    const move = params.get("move");
    const rot = params.get("rot");
    const scale = params.get("scale");
    if (selectId && (move || rot || scale)) {
      const from = el.getDocument().objects.find((o) => o.id === selectId);
      if (from) {
        const parseVec = (
          s: string | null,
          fallback: [number, number, number],
        ): [number, number, number] =>
          s ? (s.split(",").map(Number) as [number, number, number]) : fallback;
        el.applyTransform(
          selectId,
          {
            position: from.position,
            rotation: from.rotation,
            scale: from.scale,
          },
          {
            position: parseVec(move, from.position as [number, number, number]),
            rotation: parseVec(rot, from.rotation as [number, number, number]),
            scale: parseVec(scale, from.scale as [number, number, number]),
          },
        );
      }
    }

    await el.controlsReady;
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    document.body.dataset.boot = "ready";
    hud.updateDirtyUI();
  });
}
