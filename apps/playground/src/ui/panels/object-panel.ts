import type { SceneDocument, SceneObjectDTO } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import type { CameraController } from "../../camera/camera-controller";
import type { HUDController } from "../hud-controller";
import { BasePanel } from "../panel";

export interface ObjectPanelOptions {
  el: SceneEditorElement;
  hud: HUDController;
  camera: CameraController;
}

/**
 * Object-graph editing: `addObject` / `removeObject` / `reparent`.
 *
 * These three are what separate an editor from a viewer — the document is a list
 * of objects plus a parent link, and every edit is one undoable command (the SDK
 * builds the commands; the host only supplies intent). The panel stays single
 * selection shaped because that is what the click-to-select viewport produces.
 */
export class ObjectPanel extends BasePanel {
  readonly #options: ObjectPanelOptions;
  /** Signature of the current parent options, so a rebuild cannot steal a pick. */
  #parentSignature = "";

  constructor(options: ObjectPanelOptions) {
    super();
    this.#options = options;
  }

  mount(): void {
    this.click("#btn-duplicate", () => void this.duplicate());
    this.click("#btn-delete", () => this.remove());
    this.click("#btn-add-box", () => void this.addBox());

    const parentSelect = document.querySelector<HTMLSelectElement>("#parent-select");
    if (parentSelect) {
      this.listen(parentSelect, "change", () => this.reparent(parentSelect.value));
    }

    this.listen(this.#options.el, "selection-change", () => this.refresh());
    // A child added/removed below the selected object changes the candidate set.
    this.listen(this.#options.el, "history-change", () => this.refresh());

    this.refresh();
  }

  /** Enable what the current selection allows and rebuild the parent list. */
  refresh(): void {
    const doc = this.#document();
    const selected = this.#selected(doc);

    for (const selector of ["#btn-duplicate", "#btn-delete"]) {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (button) button.disabled = selected === null;
    }
    const addButton = document.querySelector<HTMLButtonElement>("#btn-add-box");
    if (addButton) addButton.disabled = doc === null;

    const parentSelect = document.querySelector<HTMLSelectElement>("#parent-select");
    if (!parentSelect) return;

    parentSelect.disabled = selected === null;
    const objects = doc?.objects ?? [];
    const blocked = selected ? subtreeIds(objects, selected.id) : new Set<string>();
    const candidates = objects.filter((object) => !blocked.has(object.id));
    const signature = candidates.map((object) => object.id).join(",");

    if (signature !== this.#parentSignature) {
      this.#parentSignature = signature;
      parentSelect.replaceChildren(new Option("场景根", ""));
      for (const object of candidates) {
        parentSelect.add(new Option(object.name || object.id, object.id));
      }
    }
    parentSelect.value = selected?.parentId ?? "";
  }

  /** `addObject` with a copied DTO: same asset/geometry, new id, nudged aside. */
  async duplicate(): Promise<void> {
    const doc = this.#document();
    const source = this.#selected(doc);
    if (!doc || !source) return;

    const id = uniqueId(doc.objects, `${source.id}-copy`);
    const copy: SceneObjectDTO = {
      ...structuredClone(source),
      id,
      name: `${source.name} 副本`,
      position: [source.position[0] + 0.7, source.position[1], source.position[2] + 0.7],
    };

    try {
      await this.#options.el.addObject(copy);
      this.#options.el.select([id]);
      this.#options.hud.showToast(`已复制为「${copy.name}」`);
    } catch (error) {
      this.#options.hud.showToast(errorText(error, "复制失败"));
    } finally {
      this.refresh();
    }
  }

  /** `addObject` with a procedural `primitive`: no asset needed. */
  async addBox(): Promise<void> {
    const doc = this.#document();
    if (!doc) return;
    const id = uniqueId(doc.objects, "box");
    const { center, size } = this.#options.camera.getBoundingInfo();
    const box: SceneObjectDTO = {
      id,
      type: "primitive",
      name: `立方体 ${id.replace("box", "") || "0"}`.trim(),
      geometry: { kind: "box" },
      // To the right of the current content, resting on the same floor.
      position: [center.x + size.x / 2 + 0.8, center.y - size.y / 2 + 0.5, center.z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    };

    try {
      await this.#options.el.addObject(box);
      this.#options.el.select([id]);
      this.#options.hud.showToast("已新增立方体（primitive 对象）");
    } catch (error) {
      this.#options.hud.showToast(errorText(error, "新增失败"));
    } finally {
      this.refresh();
    }
  }

  /** `removeObject` — the SDK removes the whole subtree in one step. */
  remove(): void {
    const selected = this.#selected(this.#document());
    if (!selected) return;

    try {
      this.#options.el.removeObject(selected.id);
      this.#options.hud.showToast(`已删除「${selected.name || selected.id}」`);
    } catch (error) {
      this.#options.hud.showToast(errorText(error, "删除失败"));
    } finally {
      this.refresh();
    }
  }

  /**
   * `reparent`. The transform stays local (the SDK does not compensate world
   * position), so the child moves with its new parent — selecting the parent
   * afterwards is what makes that visible: drag it and the child follows.
   */
  reparent(parentId: string): void {
    const doc = this.#document();
    const selected = this.#selected(doc);
    if (!doc || !selected) return;
    const nextParent = parentId === "" ? undefined : parentId;
    if (selected.parentId === nextParent) return;

    try {
      this.#options.el.reparent(selected.id, nextParent);
      const parent = nextParent ? doc.objects.find((o) => o.id === nextParent) : null;
      if (nextParent) {
        this.#options.el.select([nextParent]);
        this.#options.hud.showToast(
          `「${selected.name || selected.id}」已挂到「${parent?.name ?? nextParent}」下，随它一起变换`,
        );
      } else {
        this.#options.hud.showToast(`「${selected.name || selected.id}」已移到场景根`);
      }
    } catch (error) {
      this.#options.hud.showToast(errorText(error, "调整层级失败"));
    } finally {
      this.refresh();
    }
  }

  #document(): SceneDocument | null {
    try {
      return this.#options.el.getDocument();
    } catch {
      return null;
    }
  }

  #selected(doc: SceneDocument | null) {
    const id = this.#options.el.selectedIds[0];
    if (!doc || !id) return null;
    return doc.objects.find((object) => object.id === id) ?? null;
  }
}

/** `id`, `id-2`, `id-3` … — the first spelling the document does not use. */
function uniqueId(objects: readonly { id: string }[], base: string): string {
  const used = new Set(objects.map((object) => object.id));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** One id cannot be its own parent, nor a child of its own descendant. */
function subtreeIds(
  objects: readonly { id: string; parentId?: string | undefined }[],
  rootId: string,
): Set<string> {
  const blocked = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of objects) {
      if (!object.parentId || blocked.has(object.id)) continue;
      if (blocked.has(object.parentId)) {
        blocked.add(object.id);
        grew = true;
      }
    }
  }
  return blocked;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? `${fallback}：${error.message}` : fallback;
}
