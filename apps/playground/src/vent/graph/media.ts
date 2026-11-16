/**
 * Media 注册替换机制。
 *
 * Media 是「模型 → DOM 节点」的适配器：默认提供 DOM 实现，宿主可
 * `registerMedia("equip", factory)` 换成 Vue / React / Solid / Web Component 版本。
 * frameworkMedia() 给出统一桥接写法：框架只负责 mount/update/unmount 容器，
 * 定位、碰撞、样式合并与聚合仍由 GraphScene 统一驱动。
 */
import type { GraphModel } from "./graph-model";
import type { Bounds, ScreenPoint } from "./types";

export interface MediaSceneLike {
  readonly models: readonly GraphModel[];
  modelById(id: string): GraphModel | undefined;
}

export interface MediaContext {
  scene: MediaSceneLike;
  host: HTMLElement;
}

export interface Media<T extends GraphModel = GraphModel> {
  readonly el: HTMLElement;
  /** 根据 model.currentStyle / states / 碰撞标记刷新视图。 */
  update(model: T): void;
  /** 自定义组件尺寸时报告真实 AABB；不实现则用 GraphScene 的默认估算。 */
  getBounds?(model: T, screen: ScreenPoint, fallback: Bounds): Bounds;
  destroy?(): void;
}

export type MediaFactory<T extends GraphModel = GraphModel> = (model: T, ctx: MediaContext) => Media<T>;

export class MediaRegistry {
  #factories = new Map<string, MediaFactory<GraphModel>>();

  register<T extends GraphModel>(name: string, factory: MediaFactory<T>): this {
    this.#factories.set(name, factory as MediaFactory<GraphModel>);
    return this;
  }

  unregister(name: string): boolean {
    return this.#factories.delete(name);
  }

  has(name: string): boolean {
    return this.#factories.has(name);
  }

  create<T extends GraphModel>(name: string, model: T, ctx: MediaContext): Media<T> {
    const factory = this.#factories.get(name);
    if (!factory) throw new Error(`未注册的图元 Media: ${name}`);
    return factory(model, ctx) as Media<T>;
  }
}

/** 任意框架的桥接适配器：mount 负责建 tree，update 负责把 model 推给组件。 */
export interface FrameworkAdapter<T extends GraphModel = GraphModel> {
  mount(el: HTMLElement, model: T, ctx: MediaContext): void;
  update(el: HTMLElement, model: T): void;
  unmount?(el: HTMLElement): void;
}

export function frameworkMedia<T extends GraphModel = GraphModel>(adapter: FrameworkAdapter<T>): MediaFactory<T> {
  return (model, ctx) => {
    const el = document.createElement("div");
    el.dataset.id = model.id;
    adapter.mount(el, model, ctx);
    return {
      el,
      update: (m) => adapter.update(el, m),
      destroy: () => adapter.unmount?.(el),
    };
  };
}
