/**
 * 图元场景：投影 → 矩形测量 → 四叉树碰撞 → 样式合并 → Media 更新。
 * 与 old LabelLayer 的同名流程一一对应，但不依赖 three：投影由调用方注入。
 */
import { AggregationChain } from "./aggregation-chain";
import { resolveCollisions } from "./collision";
import { equipDomMedia, spaceDomMedia } from "./dom-media";
import type { GraphModel } from "./graph-model";
import { MediaRegistry, type Media, type MediaFactory, type MediaSceneLike } from "./media";
import { StateStyleTable } from "./state-styles";
import type { Bounds, ScreenPoint, StateStyles } from "./types";

/** 把世界坐标投到屏幕像素；返回 false 表示在视锥外。 */
export type Projector = (world: { x: number; y: number; z: number }, width: number, height: number, out: ScreenPoint) => boolean;

export interface GraphSceneOptions {
  host?: HTMLElement;
  rootId?: string;
  project: Projector;
  measureText?: (text: string) => number;
  maxObjects?: number;
  maxLevels?: number;
}

export class GraphScene implements MediaSceneLike {
  readonly root: HTMLElement;
  readonly registry = new MediaRegistry();
  readonly chain = new AggregationChain();

  #models: GraphModel[] = [];
  #medias = new Map<string, Media<GraphModel>>();
  #tables = new Map<string, StateStyleTable>();
  #click: ((model: GraphModel, ev: MouseEvent) => void) | null = null;
  readonly #project: Projector;
  readonly #measureText: (text: string) => number;
  readonly #maxObjects: number;
  readonly #maxLevels: number;

  constructor(options: GraphSceneOptions) {
    this.#project = options.project;
    this.#measureText = options.measureText ?? ((s) => s.length * 12);
    this.#maxObjects = options.maxObjects ?? 30;
    this.#maxLevels = options.maxLevels ?? 10;

    this.root = document.createElement("div");
    this.root.id = options.rootId ?? "labels";
    (options.host ?? document.body).appendChild(this.root);

    // 默认 DOM 媒体；宿主可 registerMedia 同键覆盖
    this.registerMedia("equip", equipDomMedia);
    this.registerMedia("space", spaceDomMedia);

    // 事件委托：自定义 Media 只要保留 data-id 就能继续参与点选
    this.root.addEventListener("click", (ev) => {
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-id]");
      const model = target ? this.modelById(target.dataset.id ?? "") : undefined;
      if (!model) return;
      ev.stopPropagation();
      this.#click?.(model, ev);
    });
  }

  onModelClick(handler: (model: GraphModel, ev: MouseEvent) => void): this {
    this.#click = handler;
    return this;
  }

  registerMedia<T extends GraphModel>(name: string, factory: MediaFactory<T>): this {
    this.registry.register(name, factory);
    return this;
  }

  /** 按 kind 设置状态样式表，并同步给已有模型。 */
  setStateStyles(kind: string, config: StateStyles): this {
    let table = this.#tables.get(kind);
    if (!table) {
      table = new StateStyleTable();
      this.#tables.set(kind, table);
    }
    table.setStateStyles(config);
    for (const m of this.#models) if (m.kind === kind) m.bindStyleTable(table);
    return this;
  }

  get models(): readonly GraphModel[] {
    return this.#models;
  }

  modelById(id: string): GraphModel | undefined {
    return this.#models.find((m) => m.id === id);
  }

  /** 整批替换图元：销毁旧 Media、清空聚合链、按注册表创建新 Media。 */
  setModels(models: readonly GraphModel[]): this {
    for (const media of this.#medias.values()) media.destroy?.();
    this.#medias.clear();
    this.root.replaceChildren();
    this.chain.clear();
    this.#models = [...models];

    for (const m of this.#models) {
      let table = this.#tables.get(m.kind);
      if (!table) {
        table = new StateStyleTable();
        this.#tables.set(m.kind, table);
      }
      m.bindStyleTable(table);
      const media = this.registry.create(m.mediaName || m.kind, m, { scene: this, host: this.root });
      this.root.appendChild(media.el);
      this.#medias.set(m.id, media);
    }
    return this;
  }

  /** 每帧（或相机变化时）调用：投影 + 碰撞 + 样式 + DOM 落位。 */
  layout(width: number, height: number): void {
    const out: ScreenPoint = { x: 0, y: 0 };
    for (const m of this.#models) {
      m.visible = this.#project(m.world, width, height, out);
      m.screen.x = out.x;
      m.screen.y = out.y;
      // 避让量每帧从基线重算：输入不变则结果不变，不会逐帧漂移。
      m.textOffsetY = 0;
    }

    for (const m of this.#models) {
      const fallback = this.#defaultBounds(m);
      const media = this.#medias.get(m.id);
      const bounds: Bounds = media?.getBounds?.(m, m.screen, fallback) ?? fallback;
      m.iconRect = bounds.icon;
      m.textRect = bounds.text;
      if (!m.visible) {
        m.iconRect = null;
        m.textRect = null;
      }
    }

    resolveCollisions(this.#models, this.chain, {
      bounds: { x: -80, y: -80, w: width + 160, h: height + 160 },
      maxObjects: this.#maxObjects,
      maxLevels: this.#maxLevels,
    });

    for (const m of this.#models) {
      m.setState("offscreen", !m.visible);
      m.setState("text-hidden", m.textHidden);
      m.caclCurrentStyle();
      const media = this.#medias.get(m.id);
      if (!media) continue;
      media.el.style.left = `${m.screen.x}px`;
      media.el.style.top = `${m.screen.y}px`;
      media.update(m);
    }
  }

  #defaultBounds(m: GraphModel): Bounds {
    const { x, y } = m.screen;
    if (m.kind === "equip") {
      const tw = this.#measureText(m.label);
      return {
        icon: { x: x - 12, y: y - 12, w: 24, h: 24 },
        text: { x: x - tw / 2 - 2.5, y: y + 16, w: tw + 5, h: 21 },
      };
    }
    const tw = Math.max(this.#measureText(m.label), this.#measureText(m.detail));
    return {
      icon: null,
      text: { x: x - tw / 2 - 2.5, y: y - 38 + m.textOffsetY, w: tw + 5, h: 38 },
    };
  }
}
