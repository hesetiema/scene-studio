import * as THREE from "three";
import type { SceneDocument } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { ThreeRuntime } from "@scenio/scene-editor/three";

interface ExplodeCache {
  key: string;
  /** World-space centre of each object at factor 0 — the direction source. */
  centers: Map<string, THREE.Vector3>;
  sceneCenter: THREE.Vector3;
  spread: number;
}

const FALLBACK_DIRECTIONS = [
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(-1, 0, 0),
];

/**
 * Exploded view (component explode slider).
 *
 * The preview is a runtime-only offset: object transforms come from the
 * document (always the baseline), so the slider is idempotent, never fights the
 * gizmo/undo stack, and always restores exactly at 0%.
 */
export class ExplodeController {
  readonly #el: SceneEditorElement;
  readonly #getRuntime: () => ThreeRuntime | null;

  #factor = 0;
  #cache: ExplodeCache | null = null;

  constructor(el: SceneEditorElement, getRuntime: () => ThreeRuntime | null) {
    this.#el = el;
    this.#getRuntime = getRuntime;
  }

  get factor(): number {
    return this.#factor;
  }

  setFactor(value: number): void {
    const rt = this.#getRuntime();
    if (!rt) return;

    const doc = this.#currentDocument();
    if (!doc) return;

    const factor = THREE.MathUtils.clamp(value, 0, 1);
    const cache = this.#ensureCache(rt, doc.objects.map((o) => o.id));
    if (!cache) return;

    this.#factor = factor;

    doc.objects.forEach((dto, index) => {
      const obj = rt.getObjectById(dto.id);
      if (!obj) return;
      const base = new THREE.Vector3(dto.position[0], dto.position[1], dto.position[2]);
      const center = cache.centers.get(dto.id);
      const direction = center
        ? center.clone().sub(cache.sceneCenter)
        : new THREE.Vector3();

      if (direction.lengthSq() < 1e-6) {
        const fallback = FALLBACK_DIRECTIONS[index % FALLBACK_DIRECTIONS.length];
        if (fallback) direction.copy(fallback);
      }

      obj.position.copy(base).addScaledVector(direction.normalize(), cache.spread * factor);
    });

    this.#syncUI();
    rt.render();
  }

  /** Call on every document load: drops cached centres and restores 0%. */
  reset(): void {
    this.#cache = null;
    this.#factor = 0;
    const rt = this.#getRuntime();
    const doc = this.#currentDocument();
    if (rt && doc) {
      for (const dto of doc.objects) {
        const obj = rt.getObjectById(dto.id);
        if (!obj) continue;
        obj.position.set(dto.position[0], dto.position[1], dto.position[2]);
      }
      rt.render();
    }
    this.#syncUI();
  }

  #currentDocument(): SceneDocument | null {
    try {
      return this.#el.getDocument();
    } catch {
      return null;
    }
  }

  #ensureCache(rt: ThreeRuntime, ids: string[]): ExplodeCache | null {
    const key = ids.join("|");
    if (this.#cache && this.#cache.key === key) return this.#cache;

    const centers = new Map<string, THREE.Vector3>();
    const bounds = new THREE.Box3();
    const objectBox = new THREE.Box3();

    for (const id of ids) {
      const obj = rt.getObjectById(id);
      if (!obj) continue;
      // Measured before any offset is applied on this pass (cache is rebuilt on load).
      objectBox.setFromObject(obj);
      if (objectBox.isEmpty()) continue;
      centers.set(id, objectBox.getCenter(new THREE.Vector3()));
      bounds.union(objectBox);
    }

    if (centers.size === 0) return null;

    const sceneCenter = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const spread = Math.max(size.x, size.y, size.z, 0.5) * 0.45;

    this.#cache = { key, centers, sceneCenter, spread };
    return this.#cache;
  }

  #syncUI(): void {
    const slider = document.querySelector<HTMLInputElement>("#explode-slider");
    const label = document.querySelector<HTMLElement>("#explode-val");
    const percent = Math.round(this.#factor * 100);
    if (slider) slider.value = String(percent);
    if (label) label.textContent = `${percent}%`;
  }
}
