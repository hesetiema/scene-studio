import type { ThreeRuntime } from "@scenio/scene-editor/three";
import type { ViewerController } from "../../viewer/viewer-controller";
import type { ViewerState, ViewerStore } from "../../viewer/viewer-state";
import { BasePanel } from "../panel";

export interface AnimationPanelOptions {
  store: ViewerStore;
  viewer: ViewerController;
  getRuntime: () => ThreeRuntime | null;
}

/**
 * glTF animation transport (reference: Animation folder in the dat.GUI panel):
 * clip list, play/pause, restart, speed and a scrubber.
 */
export class AnimationPanel extends BasePanel {
  readonly #store: ViewerStore;
  readonly #viewer: ViewerController;
  readonly #getRuntime: () => ThreeRuntime | null;

  #unsubscribe: (() => void) | null = null;
  #timer: number | null = null;

  constructor(options: AnimationPanelOptions) {
    super();
    this.#store = options.store;
    this.#viewer = options.viewer;
    this.#getRuntime = options.getRuntime;
  }

  mount(): void {
    const select = document.querySelector<HTMLSelectElement>("#anim-select");
    if (select) {
      this.listen(select, "change", () => {
        const clipId = select.value || null;
        this.#store.patch({ animation: { clipId, playing: clipId !== null } });
      });
    }

    this.click("#anim-play", () => this.togglePlay());
    this.click("#anim-restart", () => this.restart());

    const speed = document.querySelector<HTMLInputElement>("#anim-speed");
    if (speed) {
      this.listen(speed, "input", () => {
        this.#store.patch({ animation: { speed: Number(speed.value) } });
      });
    }

    const time = document.querySelector<HTMLInputElement>("#anim-time");
    if (time) {
      this.listen(time, "input", () => {
        this.#getRuntime()?.setAnimationTime(Number(time.value));
      });
    }

    this.#unsubscribe = this.#store.subscribe((next) => this.sync(next));
    this.#timer = window.setInterval(() => this.syncProgress(), 120);
    this.refresh();
  }

  /** Rebuild the clip list after a document load. */
  refresh(): void {
    const clips = this.#viewer.animations;
    const select = document.querySelector<HTMLSelectElement>("#anim-select");

    if (select) {
      select.replaceChildren();
      if (clips.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "无动画";
        select.append(option);
        select.disabled = true;
      } else {
        select.disabled = false;
        for (const clip of clips) {
          const option = document.createElement("option");
          option.value = clip.id;
          option.textContent = `${clip.name} (${clip.duration.toFixed(2)}s)`;
          select.append(option);
        }
      }
    }

    this.syncText("#anim-count", String(clips.length));

    const current = this.#store.state.animation;
    const clipId = clips.some((clip) => clip.id === current.clipId)
      ? current.clipId
      : (clips[0]?.id ?? null);
    if (clipId !== current.clipId) {
      this.#store.patch({
        animation: { clipId, playing: clipId !== null ? current.playing : false },
      });
    }

    this.sync(this.#store.state);
    this.syncProgress();
  }

  togglePlay(): void {
    const { clipId, playing } = this.#store.state.animation;
    if (!clipId) {
      const first = this.#viewer.animations[0];
      if (!first) return;
      this.#store.patch({ animation: { clipId: first.id, playing: true } });
      return;
    }
    this.#store.patch({ animation: { playing: !playing } });
  }

  restart(): void {
    const clipId = this.#store.state.animation.clipId;
    if (!clipId) return;
    this.#viewer.playClip(clipId);
    this.#store.patch({ animation: { playing: true } });
  }

  sync(state: ViewerState): void {
    const select = document.querySelector<HTMLSelectElement>("#anim-select");
    if (select) select.value = state.animation.clipId ?? "";

    // A model without clips still shows the transport, but it must not be usable.
    const hasClips = this.#viewer.animations.length > 0;
    for (const selector of ["#anim-play", "#anim-restart", "#anim-speed", "#anim-time"]) {
      const control = document.querySelector<HTMLButtonElement | HTMLInputElement>(selector);
      if (control) control.disabled = !hasClips;
    }

    this.syncActive("#anim-play", state.animation.playing);
    this.syncText("#anim-play", state.animation.playing ? "暂停" : "播放");

    const speed = document.querySelector<HTMLInputElement>("#anim-speed");
    if (speed && document.activeElement !== speed) speed.value = String(state.animation.speed);
    this.syncText("#anim-speed-val", `${state.animation.speed.toFixed(2)}x`);
  }

  syncProgress(): void {
    const duration = this.#viewer.animationDuration;
    const time = this.#viewer.animationTime;

    const input = document.querySelector<HTMLInputElement>("#anim-time");
    if (input) {
      input.max = String(duration > 0 ? duration : 1);
      if (document.activeElement !== input) input.value = String(time);
    }
    this.syncText("#anim-time-val", `${time.toFixed(2)}s`);
  }

  destroy(): void {
    super.destroy();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
