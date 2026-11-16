/**
 * 图元模型：状态、样式、屏幕矩形与聚合链的最小公共抽象。
 * 不认识 three、不认识 DOM，Vue/React/Solid/Web Component 的媒体都可以读它。
 */
import { StateStyleTable } from "./state-styles";
import type { GraphStyle, ModelKind, Rect, ScreenPoint } from "./types";

export interface GraphModelInit {
  id: string;
  kind: ModelKind;
  world: { x: number; y: number; z: number };
  label?: string;
  detail?: string;
  weight?: number;
  /** 覆盖 MediaRegistry 的查找键，默认等于 kind。 */
  mediaName?: string;
  /** 语义图标名（fan/window/...），由媒体自行映射到 SVG；非渲染层不解释。 */
  icon?: string;
}

export class GraphModel {
  readonly id: string;
  readonly kind: ModelKind;
  readonly world: { x: number; y: number; z: number };
  label: string;
  detail: string;
  weight: number;
  mediaName: string;
  /** 语义图标名，Media 据此选择对应 SVG；默认 fan。 */
  icon: string;

  /** 外部注入的状态（on / fault / selected 等），样式表按此合并。 */
  readonly states = new Set<string>();
  /** 投影后的屏幕锚点；visible=false 时不参与碰撞。 */
  readonly screen: ScreenPoint = { x: 0, y: 0 };
  visible = true;
  iconRect: Rect | null = null;
  textRect: Rect | null = null;
  /**
   * 文字的垂直避让量（px，负值向上）。碰撞求解在图标压字时给出，每帧归零后重算；
   * 媒体把它应用到实际节点上，默认实现是 `marginTop`。
   */
  textOffsetY = 0;
  /** 碰撞求解结果；媒体据此隐藏对应部分。 */
  iconHidden = false;
  textHidden = false;
  /** 最近一次 caclCurrentStyle() 的结果，媒体直接消费。 */
  currentStyle: GraphStyle = {};

  #styleTable = new StateStyleTable();
  #absorbTo: GraphModel | null = null;
  readonly #children: GraphModel[] = [];

  constructor(init: GraphModelInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.world = init.world;
    this.label = init.label ?? init.id;
    this.detail = init.detail ?? "";
    this.weight = init.weight ?? 0;
    this.mediaName = init.mediaName ?? init.kind;
    this.icon = init.icon ?? "fan";
  }

  bindStyleTable(table: StateStyleTable): this {
    this.#styleTable = table;
    this.caclCurrentStyle();
    return this;
  }

  get styleTable(): StateStyleTable {
    return this.#styleTable;
  }

  setState(name: string, active = true): this {
    if (active) this.states.add(name);
    else this.states.delete(name);
    return this;
  }

  hasState(name: string): boolean {
    return this.states.has(name);
  }

  /** 异步状态独立命名空间，避免与本地状态互相踩踏。 */
  setAsyncState(name: string, active = true): this {
    return this.setState(`async:${name}`, active);
  }

  caclCurrentStyle(): GraphStyle {
    this.currentStyle = this.#styleTable.caclCurrentStyle(this.states);
    return this.currentStyle;
  }

  /* ---- 聚合链：双向指针 + 可撤销操作由 AggregationChain 记录 ---- */

  get absorbTo(): GraphModel | null {
    return this.#absorbTo;
  }

  get children(): readonly GraphModel[] {
    return this.#children;
  }

  get isAbsorbed(): boolean {
    return this.#absorbTo !== null;
  }

  /** 沿 parent 指针走到聚合根。 */
  get root(): GraphModel {
    let node: GraphModel = this;
    while (node.#absorbTo) node = node.#absorbTo;
    return node;
  }

  /** 含自身在内的聚合总数（媒体用它显示角标计数）。 */
  get absorbedCount(): number {
    let n = 1;
    for (const child of this.#children) n += child.absorbedCount;
    return n;
  }

  /** 聚合体内的全部模型（自身 + 递归成员），供「点角标展开列表」使用。 */
  getGroupMembers(): GraphModel[] {
    const out: GraphModel[] = [this];
    for (const child of this.#children) out.push(...child.getGroupMembers());
    return out;
  }

  attach(child: GraphModel): void {
    if (child === this || child.#absorbTo === this) return;
    if (!this.#children.includes(child)) this.#children.push(child);
    child.#absorbTo = this;
  }

  detach(child: GraphModel): void {
    const i = this.#children.indexOf(child);
    if (i >= 0) this.#children.splice(i, 1);
    if (child.#absorbTo === this) child.#absorbTo = null;
  }
}
