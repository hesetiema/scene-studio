/**
 * `embed.html` — the smallest useful integration.
 *
 * Everything here is the element talking to the host through events and slots:
 * no document, no panels, no host-side camera code. The three lines that matter
 * are in the HTML (`<scene-editor src>`); this file only proves the contract by
 * printing the events and placing a hotspot from a click.
 */
import { defineSceneEditor, type SceneEditorElement } from "@scenio/scene-editor/element";

const HOTSPOT = "hotspot-pick";

defineSceneEditor();

const el = document.querySelector<SceneEditorElement>("#preview")!;
const logEl = document.querySelector<HTMLUListElement>("#log")!;
const fill = document.querySelector<HTMLElement>("#progress-fill");

function log(line: string): void {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString([], { hour12: false });
  item.innerHTML = `<b>${time}</b> ${line}`;
  logEl.prepend(item);
  while (logEl.children.length > 40) logEl.lastElementChild?.remove();
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;

el.addEventListener("progress", ({ detail }) => {
  if (fill) fill.style.width = pct(detail.totalProgress);
  log(`progress ${pct(detail.totalProgress)} · ${detail.reason}`);
});

el.addEventListener("load", ({ detail }) => {
  if (fill) fill.style.width = "0";
  log(`load · ${detail.sceneId}`);
});

el.addEventListener("poster-dismissed", () => {
  // `loaded` 说「有内容」，`modelIsVisible` 还要「在视口里 + 海报已收」，
  // 所以这两个探针只有在海报收起之后才可能同时为真。
  log(`poster-dismissed · loaded=${el.loaded} · modelIsVisible=${el.modelIsVisible}`);
});
el.addEventListener("model-visibility", ({ detail }) => log(`model-visibility=${detail.visible}`));
el.addEventListener("error", ({ detail }) => log(`error ${detail.code}: ${detail.message}`));
el.addEventListener("visibility-change", ({ detail }) => log(`visibility-change=${detail.visible}`));

// ---------------------------------------------------------------------------
// 热点：点击落点由 positionAndNormalFromPoint() 给出，锚点用槽位声明
// ---------------------------------------------------------------------------

let pointerDown: { x: number; y: number } | null = null;

el.addEventListener("pointerdown", (event) => {
  const pointer = event as PointerEvent;
  pointerDown = { x: pointer.clientX, y: pointer.clientY };
});

el.addEventListener("click", (event) => {
  const click = event as MouseEvent;
  // 拖拽环绕也会以一个 click 结束：位移超过 4px 就不算「点」。
  const start = pointerDown;
  pointerDown = null;
  if (!start) return;
  if (Math.hypot(click.clientX - start.x, click.clientY - start.y) > 4) return;
  placeHotspot(click.clientX, click.clientY);
});

function placeHotspot(clientX: number, clientY: number): void {
  const hit = el.positionAndNormalFromPoint(clientX, clientY);
  if (!hit) {
    log("点击未命中模型");
    return;
  }

  let node = el.querySelector<HTMLElement>(`[slot="${HOTSPOT}"]`);
  if (!node) {
    node = document.createElement("div");
    node.slot = HOTSPOT;
    node.className = "hotspot";
    node.textContent = "热点";
    // 槽位只在带 data-position 时才被登记成锚点：先写坐标，再 refreshSlots()。
    node.dataset.position = hit.position.map((value) => value.toFixed(3)).join(" ");
    node.dataset.normal = hit.normal.map((value) => value.toFixed(3)).join(" ");
    el.appendChild(node);
    el.refreshSlots();
  }

  // 之后每次点击都走 updateHotspot（与直接改 data-position 等价）。
  el.updateHotspot({
    name: HOTSPOT,
    position: hit.position.map((value) => value.toFixed(3)).join(" "),
    normal: hit.normal.map((value) => value.toFixed(3)).join(" "),
  });

  const state = el.queryHotspot(HOTSPOT);
  if (state) {
    log(
      `hotspot → 屏幕 (${state.canvasPosition.x.toFixed(0)}, ${state.canvasPosition.y.toFixed(0)})` +
        ` · facingCamera=${state.facingCamera}`,
    );
  } else {
    log("hotspot → null（锚点在视锥外）");
  }
}

void el.ready.then(() => log("scene-ready"));
