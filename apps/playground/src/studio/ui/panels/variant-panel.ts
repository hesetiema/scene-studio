import type { MorphTargetInfo } from "@scenio/scene-editor";
import type { SceneEditorElement } from "@scenio/scene-editor/element";
import { BasePanel } from "../panel";

export interface VariantPanelOptions {
  el: SceneEditorElement;
}

/**
 * What the *asset* declares: `KHR_materials_variants`, cameras authored in the
 * glTF, and morph-target channels — model-viewer's `variant-name` /
 * `camera-name` / `morphTargets` surface.
 *
 * Deliberately outside the viewer store: these are asset-scoped, so carrying
 * them into the undo stack would re-apply "beach" to the next model that has no
 * such variant. They are transport state, not document state — nothing here
 * dirties the scene, and a load resets all three.
 */
export class VariantPanel extends BasePanel {
  readonly #el: SceneEditorElement;
  /** Option signature, so a rebuild does not reset the user's pick. */
  #signature = "";
  /** `objectId|meshIndex|targetIndex` of the morph channel the slider drives. */
  #morphKey = "";

  constructor(options: VariantPanelOptions) {
    super();
    this.#el = options.el;
  }

  mount(): void {
    const variants = document.querySelector<HTMLSelectElement>("#variant-select");
    if (variants) {
      this.listen(variants, "change", () => {
        this.#el.variantName = variants.value === "" ? null : variants.value;
        this.#writeHint();
      });
    }

    const cameras = document.querySelector<HTMLSelectElement>("#asset-camera-select");
    if (cameras) {
      this.listen(cameras, "change", () => {
        this.#el.setCameraByName(cameras.value === "" ? null : cameras.value);
        this.#writeHint();
      });
    }

    const morph = document.querySelector<HTMLSelectElement>("#morph-select");
    if (morph) {
      this.listen(morph, "change", () => {
        this.#morphKey = morph.value;
        this.#syncMorphSlider();
      });
    }

    const slider = document.querySelector<HTMLInputElement>("#morph-slider");
    if (slider) {
      this.listen(slider, "input", () => {
        const target = parseMorphKey(this.#morphKey);
        if (!target) return;
        // 受动画驱动的通道会拒绝写入（mixer 下一帧就覆盖），返回值说明是否生效。
        const applied = this.#el.setMorphInfluence(
          target.objectId,
          target.meshIndex,
          target.targetIndex,
          Number(slider.value) / 100,
        );
        this.syncText("#morph-val", applied ? `${slider.value}%` : "被动画驱动");
      });
    }

    // 换资产 / 增删部件都会改变「资产声明了什么」
    this.listen(this.#el, "load", () => this.refresh());
    this.listen(this.#el, "history-change", () => this.refresh());

    this.refresh();
  }

  /** Re-read the three declarations and rebuild the option lists if they moved. */
  refresh(): void {
    let variants: string[] = [];
    let cameras: string[] = [];
    let morphs: MorphTargetInfo[] = [];
    try {
      variants = this.#el.availableVariants;
      cameras = this.#el.cameras;
      morphs = this.#el.morphTargets;
    } catch {
      return;
    }

    const signature = JSON.stringify([
      variants,
      cameras,
      morphs.map((info) => `${info.objectId}/${info.meshIndex}/${info.targetIndex}/${info.driven}`),
    ]);
    const changed = signature !== this.#signature;
    this.#signature = signature;

    // 三样都是「资产声明了什么」，大部分 GLB 一样也没有：整组收起来，
    // 有声明时才出现，并把数量写进标题——否则用户要展开一个空组才知道没用。
    const declared = [
      variants.length ? `${variants.length} 套` : null,
      cameras.length ? `${cameras.length} 相机` : null,
      morphs.length ? `${morphs.length} 通道` : null,
    ].filter((part): part is string => part !== null);

    const group = document.querySelector<HTMLElement>("#group-variant");
    if (group) group.hidden = declared.length === 0;

    const summary = document.querySelector<HTMLElement>("#summary-variant");
    if (summary) summary.textContent = declared.length ? `变体 · ${declared.join(" / ")}` : "变体";

    const variantSelect = document.querySelector<HTMLSelectElement>("#variant-select");
    if (variantSelect) {
      if (changed) fillSelect(variantSelect, variants, "资产默认");
      variantSelect.disabled = variants.length === 0;
      variantSelect.value = this.#el.variantName ?? "";
    }

    const cameraSelect = document.querySelector<HTMLSelectElement>("#asset-camera-select");
    if (cameraSelect) {
      if (changed) fillSelect(cameraSelect, cameras, "文档视角");
      cameraSelect.disabled = cameras.length === 0;
      cameraSelect.value = this.#el.cameraName ?? "";
    }

    const morphSelect = document.querySelector<HTMLSelectElement>("#morph-select");
    if (morphSelect) {
      if (changed) {
        morphSelect.replaceChildren(new Option(morphs.length ? "选择通道…" : "无", ""));
        for (const info of morphs) {
          const key = `${info.objectId}|${info.meshIndex}|${info.targetIndex}`;
          const label = morphs.length > 1 ? `${info.meshName} · ${info.name}` : info.name;
          morphSelect.add(new Option(info.driven ? `${label}（动画驱动）` : label, key));
        }
        this.#morphKey = morphs[0]
          ? `${morphs[0].objectId}|${morphs[0].meshIndex}|${morphs[0].targetIndex}`
          : "";
        morphSelect.value = this.#morphKey;
      }
      morphSelect.disabled = morphs.length === 0;
    }

    this.#syncMorphSlider();
    this.#writeHint();
  }

  /** Documented summary: what this asset actually declares. */
  #writeHint(): void {
    const variants = this.#count("#variant-select");
    const cameras = this.#count("#asset-camera-select");
    const morphSelect = document.querySelector<HTMLSelectElement>("#morph-select");
    const morphs = morphSelect ? Math.max(0, morphSelect.options.length - 1) : 0;

    const declared = [
      variants ? `${variants} 套变体` : "无变体",
      cameras ? `${cameras} 个内置相机` : "无内置相机",
      morphs ? `${morphs} 条形变通道` : "无形变",
    ];
    this.syncText("#variant-hint", `资产声明：${declared.join(" · ")}`);
  }

  #count(selector: string): number {
    const select = document.querySelector<HTMLSelectElement>(selector);
    return select ? Math.max(0, select.options.length - 1) : 0;
  }

  #syncMorphSlider(): void {
    const slider = document.querySelector<HTMLInputElement>("#morph-slider");
    if (!slider) return;

    const target = parseMorphKey(this.#morphKey);
    const info = target
      ? this.#el.morphTargets.find(
          (candidate) =>
            candidate.objectId === target.objectId &&
            candidate.meshIndex === target.meshIndex &&
            candidate.targetIndex === target.targetIndex,
        )
      : undefined;

    slider.disabled = !info || info.driven;
    if (!info) {
      slider.value = "0";
      this.syncText("#morph-val", "—");
      return;
    }
    if (document.activeElement !== slider) slider.value = String(Math.round(info.influence * 100));
    this.syncText("#morph-val", info.driven ? "被动画驱动" : `${Math.round(info.influence * 100)}%`);
  }
}

/** `<option value="">placeholder</option>` + one option per declared name. */
function fillSelect(select: HTMLSelectElement, names: readonly string[], placeholder: string): void {
  select.replaceChildren(new Option(placeholder, ""));
  for (const name of names) select.add(new Option(name, name));
}

function parseMorphKey(
  key: string,
): { objectId: string; meshIndex: number; targetIndex: number } | null {
  const [objectId, meshIndex, targetIndex] = key.split("|");
  if (!objectId || meshIndex === undefined || targetIndex === undefined) return null;
  return { objectId, meshIndex: Number(meshIndex), targetIndex: Number(targetIndex) };
}
