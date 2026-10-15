import * as THREE from "three";
import type { SceneDocument, SceneObjectDTO } from "../core/document/schema";
import type { RuntimeContract, RuntimeEventMap, Transform } from "../runtime/runtime-contract";
import { TypedEventBus } from "../runtime/typed-event-bus";
import { DisposerStack } from "../runtime/disposer-stack";
import { createRenderer } from "./create-renderer";
import type { RendererHandle } from "./renderer-handle";
import { createTransformControlsBinding, type TransformControlsLike } from "./transform-controls-binding";
import type { AssetCache } from "../assets/asset-cache";

export interface ThreeRuntimeOptions {
  canvas: HTMLCanvasElement;
  /**
   * Injectable seam: defaults to real WebGLRenderer via createRenderer (D1).
   * Documented WebGPU opt-in (evaluated viable 2026-10): create a WebGPURenderer,
   * `await renderer.init()` BEFORE constructing the runtime (the constructor renders),
   * then `rendererFactory: () => renderer`. Detect silent fallback via
   * `renderer.backend.isWebGPUBackend === true`. Reference: apps/playground/webgpu.html.
   */
  rendererFactory?: (canvas: HTMLCanvasElement) => RendererHandle;
  /** Injectable seam: defaults to real three OrbitControls. */
  orbitControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => {
    update: () => void;
    dispose: () => void;
  } | null;
  /** Injectable seam: defaults to real three TransformControls. */
  transformControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => TransformControlsLike & { update?: () => void; getHelper?: () => THREE.Object3D };
  /** Disable viewport controls (headless / unit tests). */
  enableControls?: boolean;
  /** Optional asset cache for assetId-based mesh loading (D11/D12). */
  assetCache?: AssetCache;
}

/**
 * Production RuntimeContract implementation backed by three.js (WebGLRenderer, D1).
 * Scene/camera/lights/grid are engine state — never persisted (D3).
 */
export class ThreeRuntime implements RuntimeContract {
  readonly events = new TypedEventBus();
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: RendererHandle;
  readonly #canvas: HTMLCanvasElement;

  #objects = new Map<string, THREE.Object3D>();
  #selectedIds: string[] = [];
  #objectDisposers = new DisposerStack();
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();
  #orbit: { update: () => void; dispose: () => void } | null = null;
  #transformBinding: ReturnType<typeof createTransformControlsBinding> | null = null;
  #transformControls: (TransformControlsLike & { update?: () => void; getHelper?: () => THREE.Object3D }) | null = null;
  #controlsReady: Promise<void>;
  #resolveControlsReady!: () => void;
  #assetCache: AssetCache | null;
  #rendering = false;

  constructor(options: ThreeRuntimeOptions) {
    this.#canvas = options.canvas;
    this.#assetCache = options.assetCache ?? null;
    this.#controlsReady = new Promise<void>((resolve) => {
      this.#resolveControlsReady = resolve;
    });
    this.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
    this.camera.position.set(6, 5, 10);
    this.camera.lookAt(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const directional = new THREE.DirectionalLight(0xffffff, 1);
    directional.position.set(5, 10, 7);
    const grid = new THREE.GridHelper(10, 10);
    this.scene.add(ambient, directional, grid);

    const factory = options.rendererFactory ?? createRenderer;
    this.renderer = factory(options.canvas);

    if (options.enableControls !== false) {
      this.#initControls(options);
    } else {
      this.#resolveControlsReady();
    }

    this.#syncSize();
  }

  /** Resolves when TransformControls (gizmo) is mounted, or immediately if disabled. */
  get controlsReady(): Promise<void> {
    return this.#controlsReady;
  }

  #initControls(options: ThreeRuntimeOptions): void {
    const dom = (this.renderer as { domElement?: HTMLElement }).domElement ?? this.#canvas;
    try {
      if (options.orbitControlsFactory) {
        this.#orbit = options.orbitControlsFactory(this.camera, dom);
      } else {
        // Lazy require keeps unit tests (no WebGL) free of examples/jsm side effects.
        void import("three/examples/jsm/controls/OrbitControls.js").then(({ OrbitControls }) => {
          const controls = new OrbitControls(this.camera, dom) as unknown as {
            update: () => void;
            dispose: () => void;
            addEventListener?: (type: string, fn: () => void) => void;
          };
          controls.addEventListener?.("change", () => this.#render());
          this.#orbit = controls;
        });
      }
    } catch {
      this.#orbit = null;
    }

    if (options.transformControlsFactory) {
      this.#mountTransformControls(options.transformControlsFactory(this.camera, dom));
      this.#resolveControlsReady();
    } else {
      // Lazy load real TransformControls (D15) — keeps unit tests free of examples/jsm.
      void import("three/examples/jsm/controls/TransformControls.js")
        .then(({ TransformControls }) => {
          const tc = new TransformControls(this.camera, dom) as unknown as TransformControlsLike & {
            getHelper?: () => THREE.Object3D;
            update?: () => void;
          };
          this.#mountTransformControls(tc);
          this.#render();
          this.#resolveControlsReady();
        })
        .catch(() => {
          // optional addon unavailable — gizmo-less runtime still works
          this.#resolveControlsReady();
        });
    }
  }

  #mountTransformControls(
    tc: (TransformControlsLike & { getHelper?: () => THREE.Object3D; update?: () => void }) | null | undefined,
  ): void {
    if (!tc) return;
    try {
      this.#transformControls = tc;
      const helper = tc.getHelper?.() ?? (tc as unknown as THREE.Object3D);
      if (helper && !this.scene.getObjectById((helper as THREE.Object3D).id)) {
        this.scene.add(helper as THREE.Object3D);
      }
      this.#transformBinding = createTransformControlsBinding({
        controls: tc,
        getSelectedObject: () => {
          const id = this.#selectedIds[0];
          return id ? (this.#objects.get(id) ?? null) : null;
        },
        onTransform: ({ from, to }) => {
          const id = this.#selectedIds[0];
          if (!id) return;
          this.events.emit("transform-commit", { id, from, to });
        },
      });
      // re-attach if selection happened before controls finished loading
      this.#syncTransformTarget();
    } catch {
      this.#transformControls = null;
      this.#transformBinding = null;
    }
  }

  /** Match renderer size to the canvas's layout box (call on resize / after connect). */
  resize(width?: number, height?: number): void {
    const w = width || this.#canvas.clientWidth || this.#canvas.width || 1;
    const h = height || this.#canvas.clientHeight || this.#canvas.height || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.#render();
  }

  #syncSize(): void {
    this.resize();
  }

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.#disposeSceneObjects();
    for (const dto of doc.objects) {
      if (dto.type !== "mesh") continue;
      if (dto.assetId && this.#assetCache) {
        try {
          await this.#materializeAsset(dto);
        } catch (err) {
          this.#emitAssetError(err, dto);
          // partial success: skip failed object, keep loading others
        }
      } else {
        this.#addPlaceholderBox(dto);
      }
    }
    this.#render();
  }

  async #materializeAsset(dto: SceneObjectDTO): Promise<void> {
    const assetId = dto.assetId!;
    const loaded = await this.#assetCache!.retain(assetId);
    const root = loaded.scene as {
      clone?: (recursive?: boolean) => unknown;
      userData?: Record<string, unknown>;
      traverse?: (fn: (o: unknown) => void) => void;
    };
    const instance =
      typeof root.clone === "function" ? (root.clone(true) as typeof root) : root;
    instance.userData = { ...(instance.userData ?? {}), objectId: dto.id };
    instance.traverse?.((child) => {
      const c = child as { userData?: Record<string, unknown> };
      if (c.userData) c.userData.objectId = dto.id;
    });
    const obj3d = instance as unknown as THREE.Object3D;
    obj3d.position.set(dto.position[0], dto.position[1], dto.position[2]);
    obj3d.rotation.set(dto.rotation[0], dto.rotation[1], dto.rotation[2]);
    obj3d.scale.set(dto.scale[0], dto.scale[1], dto.scale[2]);
    this.#objects.set(dto.id, obj3d);
    this.scene.add(obj3d);
    this.#objectDisposers.add(() => {
      // release first: removal failure must never leak a refcount (D12)
      this.#assetCache?.release(assetId);
      this.scene.remove(obj3d);
    });
  }

  #addPlaceholderBox(dto: SceneObjectDTO): void {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: 0x4f8ef7 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.objectId = dto.id;
    mesh.position.set(dto.position[0], dto.position[1], dto.position[2]);
    mesh.rotation.set(dto.rotation[0], dto.rotation[1], dto.rotation[2]);
    mesh.scale.set(dto.scale[0], dto.scale[1], dto.scale[2]);
    this.#objects.set(dto.id, mesh);
    this.scene.add(mesh);
    this.#objectDisposers.add(() => {
      this.scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    });
  }

  #emitAssetError(err: unknown, dto: SceneObjectDTO): void {
    const code =
      (err as { code?: string }).code === "asset-resolve-failed"
        ? "asset-resolve-failed"
        : "asset-load-failed";
    this.events.emit("error", {
      code,
      message: err instanceof Error ? err.message : String(err),
      cause: err,
      detail: { objectId: dto.id, assetId: dto.assetId },
    } as RuntimeEventMap["error"]);
  }

  applyTransform(id: string, t: Transform): void {
    const obj = this.#objects.get(id);
    if (!obj) return;
    obj.position.set(t.position[0], t.position[1], t.position[2]);
    obj.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
    obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    this.#render();
  }

  select(ids: string[]): void {
    this.#selectedIds = [...ids];
    this.#syncTransformTarget();
    this.#render();
  }

  clearSelection(): void {
    this.#selectedIds = [];
    this.#syncTransformTarget();
    this.#render();
  }

  #syncTransformTarget(): void {
    if (!this.#transformBinding) return;
    const id = this.#selectedIds[0];
    const obj = id ? this.#objects.get(id) : undefined;
    if (obj) {
      this.#transformBinding.attach(obj);
      this.#transformBinding.updateSelectedObject(obj);
    } else {
      this.#transformBinding.detach();
    }
  }

  get selectedIds(): readonly string[] {
    return this.#selectedIds;
  }

  getObjectById(id: string): THREE.Object3D | undefined {
    return this.#objects.get(id);
  }

  pick(clientX: number, clientY: number): string | null {
    const dom = (this.renderer as { domElement?: HTMLElement }).domElement;
    const rect = dom?.getBoundingClientRect?.();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    this.#pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.camera);
    // recursive: asset objects are Group roots — their meshes live one level down (D1 eval)
    const hits = this.#raycaster.intersectObjects([...this.#objects.values()], true);
    const id = hits[0]?.object?.userData?.objectId;
    return typeof id === "string" ? id : null;
  }

  render(): void {
    this.#render();
  }

  flushDisposers(): void {
    this.#transformBinding?.dispose();
    this.#transformBinding = null;
    if (this.#transformControls) {
      const helper =
        this.#transformControls.getHelper?.() ??
        (this.#transformControls as unknown as THREE.Object3D);
      if (helper) this.scene.remove(helper as THREE.Object3D);
      this.#transformControls.detach?.();
      this.#transformControls = null;
    }
    this.#orbit?.dispose();
    this.#orbit = null;
    this.#disposeSceneObjects();
    this.renderer.dispose();
  }

  #render(): void {
    // Re-entrancy guard: OrbitControls dispatches "change" from update(), and the
    // change listener below calls #render() again — without this guard an
    // externally mutated camera (e.g. camera.lookAt before first update) makes
    // update→change→render→update recurse until the stack overflows (found by
    // the D10 perf bench).
    if (this.#rendering) return;
    this.#rendering = true;
    try {
      this.#orbit?.update?.();
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.#rendering = false;
    }
  }

  #disposeSceneObjects(): void {
    try {
      this.#objectDisposers.flush();
    } catch {
      // object disposal errors must not block reload; renderer disposal is separate
    }
    this.#objects.clear();
    this.#selectedIds = [];
  }
}
