/**
 * 配置化状态样式表。
 *
 * 参考产品的 `setStateStyles(config)` + `caclCurrentStyle()`：多个状态同时命中时，
 * 按 priority 升序合并（后者覆盖前者），得到一份扁平的 currentStyle。
 * 样式键是语义化的（`iconColor` / `dotColor` / `opacity` …），不绑定任何渲染框架。
 */
import type { GraphStyle, StateStyleConfig, StateStyles } from "./types";

function normalize(value: StateStyleConfig | GraphStyle): StateStyleConfig {
  if (value && typeof value === "object" && "style" in value && value.style && typeof value.style === "object") {
    const config = value as StateStyleConfig;
    return {
      priority: typeof config.priority === "number" ? config.priority : 0,
      style: { ...config.style },
    };
  }
  return { priority: 0, style: { ...(value as GraphStyle) } };
}

export class StateStyleTable {
  #config: Record<string, StateStyleConfig> = {};

  /** 整表替换（与参考产品一致）：新配置立即覆盖旧配置。 */
  setStateStyles(config: StateStyles): this {
    const next: Record<string, StateStyleConfig> = {};
    for (const [state, value] of Object.entries(config)) next[state] = normalize(value);
    this.#config = next;
    return this;
  }

  get config(): Readonly<Record<string, StateStyleConfig>> {
    return this.#config;
  }

  /** 合并当前激活状态的样式；同 priority 按配置书写顺序，后者胜出。 */
  caclCurrentStyle(states: Iterable<string>): GraphStyle {
    const active: string[] = [];
    for (const s of new Set(states)) if (this.#config[s]) active.push(s);
    active.sort((a, b) => (this.#config[a]!.priority ?? 0) - (this.#config[b]!.priority ?? 0));
    const out: GraphStyle = {};
    for (const s of active) Object.assign(out, this.#config[s]!.style);
    return out;
  }

  /** 正确拼写别名，便于新消费者使用。 */
  calculateCurrentStyle(states: Iterable<string>): GraphStyle {
    return this.caclCurrentStyle(states);
  }
}
