import { BasePanel } from "../panel";

/**
 * 顶部栏与右侧控制面板的显隐开关。
 * 面板底部「收起面板」收起后，顶部出现「显示面板」用于恢复
 * （对应 three-gltf-viewer 的 Close Controls）。
 */
export class ChromePanel extends BasePanel {
  mount(): void {
    const hide = document.querySelector<HTMLButtonElement>("#btn-toggle-panel");
    const show = document.querySelector<HTMLButtonElement>("#btn-show-panel");

    this.setCollapsed(false);

    if (hide) this.listen(hide, "click", () => this.setCollapsed(true));
    if (show) this.listen(show, "click", () => this.setCollapsed(false));
  }

  setCollapsed(collapsed: boolean): void {
    document.body.classList.toggle("panel-collapsed", collapsed);
    const show = document.querySelector<HTMLButtonElement>("#btn-show-panel");
    if (show) show.hidden = !collapsed;
  }
}
