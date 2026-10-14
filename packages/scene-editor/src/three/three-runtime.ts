import * as THREE from "three";
import type { SceneDocument } from "../core/document/schema";
import type { RuntimeContract, Transform } from "../runtime/runtime-contract";
import { TypedEventBus } from "../runtime/typed-event-bus";
import { DisposerStack } from "../runtime/disposer-stack";
import { createRenderer } from "./create-renderer";
import type { RendererHandle } from "./renderer-handle";

export interface ThreeRuntimeOptions {
  canvas: HTMLCanvasElement;
  /** Injectable seam for tests; defaults to real WebGLRenderer via createRenderer (D1). */
  rendererFactory?: (canvas: HTMLCanvasElement) => RendererHandle;
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

  #objects = new Map<string, THREE.Object3D>();
  #selectedIds: string[] = [];
  #objectDisposers = new DisposerStack();
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();

  constructor(options: ThreeRuntimeOptions) {
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
  }

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.#disposeSceneObjects();
    for (const dto of doc.objects) {
      if (dto.type !== "mesh") continue;
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
    this.#render();
  }

  clearSelection(): void {
    this.#selectedIds = [];
    this.#render();
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
    const hits = this.#raycaster.intersectObjects([...this.#objects.values()], false);
    const id = hits[0]?.object?.userData?.objectId;
    return typeof id === "string" ? id : null;
  }

  render(): void {
    this.#render();
  }

  flushDisposers(): void {
    this.#disposeSceneObjects();
    this.renderer.dispose();
  }

  #render(): void {
    this.renderer.render(this.scene, this.camera);
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
