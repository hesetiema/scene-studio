/**
 * 默认 DOM 图元（不依赖框架），视觉与 vent-demo 原手写 DOM 完全一致：
 * 设备 = 圆角图标 + hover 名称 + 聚合计数 + 右上角告警点；空间 = IoT 值 + 名称。
 */
import type { GraphModel } from "./graph-model";
import type { MediaFactory } from "./media";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** 图标背景色兜底；正式色值由 setStateStyles 的 on/off/unknown 状态提供。 */
const FALLBACK_ICON_COLOR = "#8B949E";
/** 告警色兜底，与底部图例「异常」同色。 */
const FALLBACK_DOT_COLOR = "#F55047";

/**
 * 设备语义图标（model.icon）。24×24 viewBox、单色白，靠底板的运行态色区分状态。
 * - fan：三叶风扇，对应 ACVTSF / FFSC* 等通风设备（快照中 59/70 台）；
 * - window：格子窗，对应 CFC* 窗类；
 * 其余走 fan 兜底。SVG 不依赖 CSS 着色，框架无关媒体可直接复用。
 */
const FAN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="#fff">
  <path d="M11.1 12c-1.5-1-3.7-2.4-4.3-4.3-.4-1.3.6-2.6 1.9-2.3 1.6.3 2.9 2.8 3 5.3 0 .9-.2 1.4-.6 1.3z"/>
  <path d="M11.1 12c-1.5-1-3.7-2.4-4.3-4.3-.4-1.3.6-2.6 1.9-2.3 1.6.3 2.9 2.8 3 5.3 0 .9-.2 1.4-.6 1.3z" transform="rotate(120 12 12)"/>
  <path d="M11.1 12c-1.5-1-3.7-2.4-4.3-4.3-.4-1.3.6-2.6 1.9-2.3 1.6.3 2.9 2.8 3 5.3 0 .9-.2 1.4-.6 1.3z" transform="rotate(240 12 12)"/>
  <circle cx="12" cy="12" r="2.1"/>
</g></svg>`;
const WINDOW_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round">
  <rect x="4.5" y="4.5" width="15" height="15" rx="2"/>
  <path d="M12 4.5v15M4.5 12h15"/>
</svg>`;
const EQUIP_ICONS: Record<string, string> = { fan: FAN_ICON, window: WINDOW_ICON };
const FALLBACK_EQUIP_ICON = FAN_ICON;

/** 聚合体内是否含异常设备（含自身与嵌套成员）。 */
function hasFaultInGroup(model: GraphModel): boolean {
  return model.hasState("fault") || model.children.some((child) => hasFaultInGroup(child));
}

export const equipDomMedia: MediaFactory<GraphModel> = (model) => {
  const root = document.createElement("div");
  root.className = "lbl lbl-equip";
  root.dataset.id = model.id;
  root.innerHTML = `
    <div class="ic">${EQUIP_ICONS[model.icon] ?? FALLBACK_EQUIP_ICON}</div>
    <div class="grp lbl-grp hidden"><span class="grp-count">1</span><div class="grp-dot hidden" title="组内有异常设备"></div></div>
    <div class="name"></div>
    <div class="dots"><div class="dot hidden" title="异常（演示）"></div></div>
  `;
  const ic = root.querySelector<HTMLElement>(".ic")!;
  // createMedia 只在建模时调用一次，之后 update 里若语义变了也能换图标
  const svgHolder = ic;
  const grp = root.querySelector<HTMLElement>(".grp")!;
  const grpCount = root.querySelector<HTMLElement>(".grp-count")!;
  const grpDot = root.querySelector<HTMLElement>(".grp-dot")!;
  const name = root.querySelector<HTMLElement>(".name")!;
  const dots = root.querySelector<HTMLElement>(".dots")!;
  const dot = root.querySelector<HTMLElement>(".dot")!;

  return {
    el: root,
    update(m) {
      const style = m.currentStyle;
      const color = style.iconColor;
      ic.style.background = typeof color === "string" ? color : FALLBACK_ICON_COLOR;
      const wantIcon = EQUIP_ICONS[m.icon] ?? FALLBACK_EQUIP_ICON;
      if (svgHolder.dataset.icon !== m.icon) {
        svgHolder.innerHTML = wantIcon;
        svgHolder.dataset.icon = m.icon;
      }

      const count = m.absorbedCount;
      const grouped = count > 1 && !m.iconHidden;
      grp.classList.toggle("hidden", !grouped);
      if (grouped) grpCount.textContent = String(count);
      ic.classList.toggle("hidden", m.iconHidden || grouped);
      name.classList.toggle("hidden", m.textHidden || grouped);
      name.textContent = m.label;

      const faultColor = typeof style.dotColor === "string" ? style.dotColor : FALLBACK_DOT_COLOR;
      // 单设备才画自己的红点；一旦被聚合，告警上移到角标，不在成员/根图标上残留
      const showDot = typeof style.dotColor === "string" && !grouped && !m.isAbsorbed;
      dot.classList.toggle("hidden", !showDot);
      if (showDot) dot.style.background = faultColor;
      dots.classList.toggle("hidden", !showDot);

      const groupAlarm = grouped && hasFaultInGroup(m);
      grpDot.classList.toggle("hidden", !groupAlarm);
      if (groupAlarm) grpDot.style.background = faultColor;

      root.classList.toggle("selected", m.hasState("selected"));
      root.classList.toggle("hidden", !m.visible);
    },
  };
};

export const spaceDomMedia: MediaFactory<GraphModel> = (model) => {
  const root = document.createElement("div");
  root.className = "lbl lbl-space";
  root.dataset.id = model.id;
  root.innerHTML = `<div class="lux"></div><div class="name"></div>`;
  const lux = root.querySelector<HTMLElement>(".lux")!;
  const name = root.querySelector<HTMLElement>(".name")!;

  return {
    el: root,
    update(m) {
      lux.textContent = m.detail;
      root.dataset.lux = m.detail;
      name.textContent = m.label;
      root.classList.toggle("selected", m.hasState("selected"));
      root.classList.toggle("hidden", !m.visible || m.textHidden);
    },
  };
};
