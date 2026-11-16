/**
 * Light-DOM slot chrome: `slot="poster" | "progress-bar" | "error" | "hotspot-*"`
 * children, plus the built-in error overlay.
 *
 * Everything in this module is DOM state — which node is styled, what is
 * visible, what is mid-fade. It owns no document, no runtime and no lifecycle:
 * the host hands over the element, a way to reach the runtime, and a callback
 * for "the composite `model-visibility` verdict may have moved".
 *
 * It lives outside `scene-editor-element.ts` so the slot rules can be read
 * without the surrounding 3 000-line aggregation. Dependencies: `RuntimeContract`
 * types only — no `three`, not even lazily.
 */
import type { RuntimeContract } from "../runtime/runtime-contract";
import { parseVector3 } from "./attribute-math";

/** A vector in the `{x, y, z}` shape model-viewer's `queryHotspot()` returns. */
export interface HotspotVector {
  x: number;
  y: number;
  z: number;
}

/**
 * What `queryHotspot()` reports — model-viewer's `HotspotData`, field for field.
 *
 * `position` / `normal` are the values declared on the anchor (world space, the
 * same space `positionAndNormalFromPoint()` returns), `canvasPosition` is where
 * the anchor currently sits in canvas-local CSS pixels, and `facingCamera` is
 * the `data-normal` verdict. Deliberately `{x, y, z}` objects rather than this
 * repo's usual tuples, so host code written for model-viewer keeps working.
 */
export interface HotspotData {
  position: HotspotVector;
  normal: HotspotVector;
  /** Canvas pixels plus the projected NDC depth in `z`. */
  canvasPosition: HotspotVector;
  facingCamera: boolean;
}

/**
 * `updateHotspot()` input — model-viewer's `HotspotConfiguration`.
 *
 * The three geometry fields are *strings*, in the same format as the anchor
 * attributes (`data-position` / `data-normal` / `data-surface`), not vectors:
 * a host migrating from model-viewer passes through whatever it stored.
 */
export interface HotspotConfig {
  /**
   * Full slot name, prefix included (`"hotspot-tank"`) — the same key
   * `queryHotspot()` takes, because the reference keys its map by `node.slot`.
   */
  name: string;
  position?: string;
  normal?: string;
  /** Accepted for signature compatibility; surface tracking is not implemented. */
  surface?: string;
  modelIndex?: number;
}

/**
 * A `slot="hotspot-*"` anchor, plus what this element projects onto it.
 *
 * `data-position` is world space (what `positionAndNormalFromPoint()` hands
 * back), `data-normal` defaults to `+Y` — model-viewer's own default, so an
 * anchor that never declares a normal is always considered facing.
 */
interface HotspotAnchor {
  el: HTMLElement;
  /** The slot name, which is also the key `queryHotspot()` looks up. */
  name: string;
  position: [number, number, number];
  normal: [number, number, number];
  /** `data-visibility-attribute`: mirror the verdict onto `data-<value>`. */
  visibilityAttr: string | null;
  /** Last verdict, so `hotspot-visibility` fires on change instead of per frame. */
  facing: boolean | null;
}

/**
 * Light-DOM slots (no shadow root). model-viewer puts these names on `<slot>`s
 * inside its shadow tree; this element honours the same `slot` attribute on
 * plain children, which keeps `querySelector` / `:scope > ...` working for hosts
 * and for the e2e suites.
 */
const SLOT_POSTER = "poster";
const SLOT_PROGRESS = "progress-bar";
const SLOT_ERROR = "error";
const HOTSPOT_PREFIX = "hotspot-";

/**
 * `seamless-poster` fade duration (model-viewer's own poster transition is
 * 300ms). Long enough to hide the first-frame pop, short enough that the poster
 * is not still visible when a host starts an intro animation.
 */
const POSTER_FADE_MS = 300;

/** Canonical `reveal` values; anything else behaves like `auto`. */
export type RevealMode = "auto" | "interaction" | "manual";
const REVEAL_MODES: ReadonlySet<string> = new Set<RevealMode>(["auto", "interaction", "manual"]);

/** The slot families this element styles itself (no shadow root). */
type SlotRole = "poster" | "progress" | "hotspot" | "error";

/** The slice of the host element this module drives. */
export interface SlotChromeHost {
  /** The custom element: light-DOM children, attributes, `style`, dispatch. */
  readonly element: HTMLElement;
  /** Runtime for hotspot projection; `null` before init and after teardown. */
  runtime(): RuntimeContract | null;
  /**
   * Called after any change to the poster/loading state — the composite
   * `model-visibility` verdict is `loaded && inViewport && revealed`, so two of
   * its three inputs live in this module.
   */
  onSlotStateChange(): void;
}

/** Slot nodes this module styles, their own inline CSS, and what to show. */
export class SlotChrome {
  readonly #host: SlotChromeHost;
  #slotsObserver: MutationObserver | null = null;
  #slotted: Array<{ el: HTMLElement; cssText: string }> = [];
  #poster: HTMLElement | null = null;
  #progressBar: HTMLElement | null = null;
  #hotspots: HotspotAnchor[] = [];
  /** Inline values to restore when this element stops owning a node's look. */
  readonly #originalDisplay = new WeakMap<HTMLElement, string>();
  readonly #originalVisibility = new WeakMap<HTMLElement, string>();
  /** The poster node currently fading out, if any. */
  #fadingPoster: HTMLElement | null = null;
  /** `seamless-poster` fade in flight; keeps the node mounted until it ends. */
  #posterFadeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Inline opacity each poster arrived with, restored once its fade finishes. */
  readonly #posterOpacity = new WeakMap<HTMLElement, string>();
  /** Poster already dismissed (or never present); `dismissPoster()` flips it. */
  #revealed = true;
  /** `true` while a load is in flight (drives `slot="progress-bar"`). */
  #loading = false;
  /** Last failure message; `null` = healthy (drives `slot="error"`). */
  #errorMessage: string | null = null;
  /** Host-provided `slot="error"` node, when there is one. */
  #errorSlot: HTMLElement | null = null;
  /** Built-in fallback overlay, used only when the host supplied no error slot. */
  #errorOverlay: HTMLElement | null = null;

  constructor(host: SlotChromeHost) {
    this.#host = host;
  }

  /** Poster dismissed (or never present) — one input of `modelIsVisible`. */
  get revealed(): boolean {
    return this.#revealed;
  }

  /** `reveal` in canonical form; unknown values behave like the default `auto`. */
  get revealMode(): RevealMode {
    const raw = (this.#host.element.getAttribute("reveal") ?? "auto").trim().toLowerCase();
    return (REVEAL_MODES as ReadonlySet<string>).has(raw) ? (raw as RevealMode) : "auto";
  }

  /* ------------------------------------------------------------- slots ---- */

  /** Watch light-DOM children for slot nodes added, removed or re-slotted. */
  observe(): void {
    if (typeof MutationObserver === "undefined") return;
    const element = this.#host.element;
    const observer = new MutationObserver((records) => {
      // The built-in failure overlay is ours, not a slot: writing its message
      // replaces a text node, which lands here as a childList mutation on a
      // descendant. Without this filter the message re-entering `collect()`
      // → `applyErrorVisibility` → `textContent` spins the microtask queue.
      const overlay = this.#errorOverlay;
      if (overlay && records.every((record) => overlay.contains(record.target))) return;
      this.collect();
    });
    // `subtree` matters: the anchors are *children*, so without it an anchor
    // that changes its own `data-normal` (a host flipping a label to the back of
    // the model) would never be re-collected. We only ever write `style` and the
    // opted-in `data-<visibility-attribute>`, neither of which is in the filter —
    // no feedback loop.
    observer.observe(element, {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: ["slot", "data-position", "data-normal", "data-visibility-attribute"],
    });
    this.#slotsObserver = observer;
  }

  /** Re-home `slot="poster" | "progress-bar" | "error" | "hotspot-*"` children. */
  collect(): void {
    let poster: HTMLElement | null = null;
    let progress: HTMLElement | null = null;
    let error: HTMLElement | null = null;
    const hotspots: HotspotAnchor[] = [];
    const owned: Array<{ el: HTMLElement; role: SlotRole }> = [];

    for (const child of Array.from(this.#host.element.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const slot = child.getAttribute("slot");
      if (slot === null) continue;
      if (slot === SLOT_POSTER) {
        poster = child;
        owned.push({ el: child, role: "poster" });
        continue;
      }
      if (slot === SLOT_PROGRESS) {
        progress = child;
        owned.push({ el: child, role: "progress" });
        continue;
      }
      if (slot === SLOT_ERROR) {
        error = child;
        owned.push({ el: child, role: "error" });
        continue;
      }
      if (!slot.startsWith(HOTSPOT_PREFIX)) continue;
      const position = parseVector3(child.getAttribute("data-position"));
      if (position === null) continue;
      hotspots.push({
        el: child,
        name: slot,
        position,
        // model-viewer's default: an anchor with no `data-normal` faces +Y and
        // is therefore never dimmed.
        normal: parseVector3(child.getAttribute("data-normal")) ?? [0, 1, 0],
        visibilityAttr: child.getAttribute("data-visibility-attribute"),
        facing: null,
      });
      owned.push({ el: child, role: "hotspot" });
    }

    // A different poster node starts a new reveal cycle (model-viewer shows a
    // replacement poster again), while re-collecting the same node preserves it.
    if (poster !== this.#poster) this.#revealed = poster === null;
    this.#poster = poster;
    this.#progressBar = progress;
    this.#errorSlot = error;
    this.#hotspots = hotspots;

    if (owned.length > 0) this.#ensurePositionedHost();
    this.#syncSlotted(owned);
    this.applyPosterVisibility();
    this.#applyProgressVisibility();
    this.#applyErrorVisibility();
    this.updateHotspots();
    // Adding a poster to a loaded element hides the model again (the reference
    // shows a replacement poster for a new reveal cycle), so the verdict moves.
    this.#host.onSlotStateChange();
  }

  /* ------------------------------------------------------- node styling ---- */

  /** Absolute slot chrome needs a positioned containing block (the host). */
  #ensurePositionedHost(): void {
    if (typeof getComputedStyle !== "function") return;
    const element = this.#host.element;
    const position = getComputedStyle(element).position;
    if (position === "" || position === "static") element.style.position = "relative";
  }

  /** Take over new nodes, release departed ones back to their original inline CSS. */
  #syncSlotted(nodes: Array<{ el: HTMLElement; role: SlotRole }>): void {
    const next = new Set(nodes.map((node) => node.el));
    const retained: Array<{ el: HTMLElement; cssText: string }> = [];
    for (const entry of this.#slotted) {
      if (next.has(entry.el)) retained.push(entry);
      else entry.el.style.cssText = entry.cssText;
    }

    const known = new Set(retained.map((entry) => entry.el));
    for (const { el, role } of nodes) {
      if (known.has(el)) continue;
      retained.push({ el, cssText: el.style.cssText });
      this.#applySlotStyles(el, role);
    }
    this.#slotted = retained;
  }

  #applySlotStyles(el: HTMLElement, role: SlotRole): void {
    const { style } = el;
    style.position = "absolute";
    if (role === "poster") {
      style.top = "0";
      style.right = "0";
      style.bottom = "0";
      style.left = "0";
      style.zIndex = "1";
      return;
    }
    if (role === "progress") {
      style.left = "0";
      style.right = "0";
      style.bottom = "0";
      style.zIndex = "2";
      return;
    }
    if (role === "error") {
      // Covers the canvas: on a failure there is nothing else worth showing.
      style.top = "0";
      style.right = "0";
      style.bottom = "0";
      style.left = "0";
      style.zIndex = "4";
      return;
    }
    // Hotspot anchors are placed by `translate(-50%, -50%) translate(x, y)`.
    style.top = "0";
    style.left = "0";
    style.zIndex = "3";
    style.transformOrigin = "center";
  }

  /** Show/hide one slot node without losing its original inline `display`. */
  #setVisible(el: HTMLElement | null, visible: boolean): void {
    if (!el) return;
    let original = this.#originalDisplay.get(el);
    if (original === undefined) {
      original = el.style.display;
      this.#originalDisplay.set(el, original);
    }
    el.style.display = visible ? original : "none";
  }

  /* ------------------------------------------------------------- poster ---- */

  /** Re-apply the poster's visibility for the current reveal state. */
  applyPosterVisibility(): void {
    const poster = this.#poster;
    if (!poster) return;
    if (!this.#revealed) {
      // A new reveal cycle: undo a fade that is still in flight.
      this.#cancelPosterFade();
      this.#setVisible(poster, true);
      return;
    }
    // `seamless-poster` keeps the node mounted through a fade so the first
    // rendered frame cross-dissolves out of it instead of popping in.
    if (this.#fadeable() && poster.style.display !== "none") {
      this.#fadePosterOut(poster);
      return;
    }
    this.#setVisible(poster, false);
  }

  /** `seamless-poster` is opt-in: without it the poster is cut, as before. */
  #fadeable(): boolean {
    return this.#host.element.hasAttribute("seamless-poster") && typeof setTimeout === "function";
  }

  #fadePosterOut(poster: HTMLElement): void {
    const { style } = poster;
    this.#cancelPosterFade();
    this.#posterOpacity.set(poster, style.opacity);
    this.#fadingPoster = poster;
    // Passive while fading: the model behind is already interactive.
    style.pointerEvents = "none";
    style.transition = `opacity ${POSTER_FADE_MS}ms ease`;
    style.opacity = "0";
    this.#posterFadeTimer = setTimeout(() => {
      this.#posterFadeTimer = null;
      const node = this.#fadingPoster;
      this.#fadingPoster = null;
      if (!node) return;
      // The node may have been replaced or detached mid-fade.
      if (this.#poster === node) this.#setVisible(node, false);
      this.#restorePosterStyle(node);
    }, POSTER_FADE_MS);
  }

  /** Drop a fade in flight and hand the node's own style back to it. */
  #cancelPosterFade(): void {
    if (this.#posterFadeTimer !== null) {
      clearTimeout(this.#posterFadeTimer);
      this.#posterFadeTimer = null;
    }
    const node = this.#fadingPoster;
    if (!node) return;
    this.#fadingPoster = null;
    this.#restorePosterStyle(node);
  }

  #restorePosterStyle(poster: HTMLElement): void {
    const { style } = poster;
    style.opacity = this.#posterOpacity.get(poster) ?? "";
    style.transition = "";
    style.pointerEvents = "";
  }

  /** Shared reveal path: `api` always wins, the attribute filters the rest. */
  dismissPoster(reason: "load" | "interaction" | "api"): void {
    if (reason !== "api") {
      const mode = this.revealMode;
      if (mode === "manual") return;
      if (reason === "load" && mode !== "auto") return;
      if (reason === "interaction" && mode !== "interaction") return;
    }
    const dismissing = this.#poster !== null && !this.#revealed;
    this.#revealed = true;
    this.applyPosterVisibility();
    this.#host.onSlotStateChange();
    if (!dismissing) return;
    this.#host.element.dispatchEvent(new CustomEvent("poster-dismissed", { detail: {} }));
  }

  /* ---------------------------------------------------------- progress ---- */

  #applyProgressVisibility(): void {
    this.#setVisible(this.#progressBar, this.#loading);
  }

  setLoading(loading: boolean): void {
    if (loading === this.#loading) return;
    this.#loading = loading;
    this.#applyProgressVisibility();
  }

  /* -------------------------------------------------------------- error ---- */

  /**
   * Failure surface. Without it a dead WebGL context or a 404 asset left the
   * host with one `error` event and the user with a blank rectangle.
   */
  showError(message: string): void {
    this.#errorMessage = message;
    this.#applyErrorVisibility();
  }

  clearError(): void {
    if (this.#errorMessage === null) return;
    this.#errorMessage = null;
    this.#applyErrorVisibility();
  }

  #applyErrorVisibility(): void {
    const visible = this.#errorMessage !== null;
    const slot = this.#errorSlot;
    if (slot) this.#setVisible(slot, visible);
    const overlay = visible && !slot ? this.#ensureErrorOverlay() : this.#errorOverlay;
    if (overlay) {
      if (visible && !slot) {
        const message = this.#errorMessage ?? "";
        // Only when it changed: a redundant write still replaces the text node,
        // and the mutation observer sees every one of them.
        if (overlay.textContent !== message) overlay.textContent = message;
      }
      this.#setVisible(overlay, visible && !slot);
    }
  }

  /**
   * Built-in fallback text, so "no WebGL" is readable instead of empty. A host
   * that wants its own surface adds a `slot="error"` child; this node is then
   * hidden and never touches the host's DOM.
   */
  #ensureErrorOverlay(): HTMLElement {
    if (this.#errorOverlay) return this.#errorOverlay;
    const node = document.createElement("div");
    node.setAttribute("data-scene-editor-error", "");
    // Announced, not just painted: a screen reader user gets the reason too.
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    Object.assign(node.style, {
      position: "absolute",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      boxSizing: "border-box",
      font: "13px/1.5 system-ui, -apple-system, sans-serif",
      color: "#f2f4f8",
      background: "rgba(10, 14, 22, 0.82)",
      textAlign: "center",
      // Failure messages now name the URL that 404'd, and a URL is one long
      // token: without this it overflows the host box instead of wrapping.
      overflowWrap: "anywhere",
      zIndex: "4",
      pointerEvents: "none",
    });
    this.#ensurePositionedHost();
    this.#host.element.appendChild(node);
    this.#errorOverlay = node;
    return node;
  }

  /* ----------------------------------------------------------- hotspots ---- */

  /** Glue `hotspot-*` anchors to their world position after camera/resize moves. */
  updateHotspots(): void {
    if (this.#hotspots.length === 0) return;
    const runtime = this.#host.runtime();
    if (!runtime) return;
    const projectHotspot = runtime.projectHotspot;
    const projectPoint = runtime.projectPoint;
    if (!projectHotspot && !projectPoint) return;

    for (const anchor of this.#hotspots) {
      const { el, position, normal } = anchor;
      const projected = projectHotspot
        ? projectHotspot.call(runtime, position, normal)
        : { ...projectPoint!.call(runtime, position), facingCamera: true };
      // `visible: false` = behind the camera or outside the depth range.
      this.#setHotspotVisible(el, projected.visible);
      if (projected.visible) {
        el.style.transform = `translate(-50%, -50%) translate(${projected.x}px, ${projected.y}px)`;
      }
      this.#setHotspotFacing(anchor, projected.facingCamera);
    }
  }

  /**
   * Apply a `data-normal` verdict: dim the node the way model-viewer does
   * (`--min-hotspot-opacity`, default `0.25`), mirror the verdict onto
   * `data-<visibility-attribute>` when the host opted in, and announce it.
   *
   * Only runs on a change — the projection above happens every frame, and a
   * `hotspot-visibility` event per frame would be useless noise.
   */
  #setHotspotFacing(anchor: HotspotAnchor, facing: boolean): void {
    if (anchor.facing === facing) return;
    anchor.facing = facing;
    // Facing front removes the inline value rather than writing `1`, so the
    // host's own opacity (or `--max-hotspot-opacity`) still has a say.
    anchor.el.style.opacity = facing ? "" : "var(--min-hotspot-opacity, 0.25)";
    const { visibilityAttr } = anchor;
    if (visibilityAttr) anchor.el.toggleAttribute(`data-${visibilityAttr}`, facing);
    anchor.el.dispatchEvent(new CustomEvent("hotspot-visibility", { detail: { visible: facing } }));
  }

  #setHotspotVisible(el: HTMLElement, visible: boolean): void {
    let original = this.#originalVisibility.get(el);
    if (original === undefined) {
      original = el.style.visibility;
      this.#originalVisibility.set(el, original);
    }
    el.style.visibility = visible ? original : "hidden";
  }

  /**
   * Live state of a `slot="hotspot-<name>"` anchor — model-viewer's
   * `queryHotspot()`, for hosts that draw leader lines or collision-sort labels
   * in screen space.
   *
   * `null` when no anchor carries that slot name, before the runtime exists, or
   * when the projection is non-finite (the anchor sits far outside the frustum).
   * Unlike the projection used for placement, a hotspot that is merely
   * behind the camera still reports — check `facingCamera` / `canvasPosition`
   * rather than assuming non-null means on-screen.
   */
  queryHotspot(name: string): HotspotData | null {
    const anchor = this.#hotspots.find((entry) => entry.name === name);
    if (!anchor) return null;
    const runtime = this.#host.runtime();
    if (!runtime) return null;

    const projected = runtime.projectHotspot
      ? runtime.projectHotspot(anchor.position, anchor.normal)
      : runtime.projectPoint
        ? { ...runtime.projectPoint(anchor.position), facingCamera: true }
        : null;
    if (!projected) return null;
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;

    const [px, py, pz] = anchor.position;
    const [nx, ny, nz] = anchor.normal;
    return {
      position: { x: px, y: py, z: pz },
      normal: { x: nx, y: ny, z: nz },
      canvasPosition: { x: projected.x, y: projected.y, z: projected.z ?? 0 },
      facingCamera: projected.facingCamera,
    };
  }

  /**
   * Move a hotspot without touching the DOM — model-viewer's
   * `updateHotspot({name, position?, normal?, surface?})`.
   *
   * `position` / `normal` are strings in the same format as `data-position` /
   * `data-normal` (`"1 2 3"`, unit suffixes allowed). Omitted fields are left
   * alone; an unparseable field is ignored rather than throwing, so a host
   * feeding user input cannot break the anchor. Unknown names are a silent
   * no-op, exactly like the reference.
   *
   * Every anchor sharing the slot name moves: the reference keeps one hotspot
   * per slot name, so all of its nodes travel together.
   *
   * `surface` is accepted for signature compatibility but has no effect —
   * surface tracking (`data-surface` / `surfaceFromPoint()`) is not
   * implemented. Unlike the reference, this element *does* observe
   * `data-position` / `data-normal`, so the attribute route works too.
   */
  updateHotspot(config: HotspotConfig): void {
    if (!config || typeof config.name !== "string") return;
    const matches = this.#hotspots.filter((entry) => entry.name === config.name);
    if (matches.length === 0) return;

    const position = parseVector3(config.position ?? null);
    const normal = parseVector3(config.normal ?? null);
    if (position === null && normal === null) return;
    for (const anchor of matches) {
      if (position !== null) anchor.position = [...position];
      if (normal !== null) anchor.normal = [...normal];
    }
    this.updateHotspots();
  }

  /* ------------------------------------------------------------ teardown ---- */

  /** Drop the observer and hand every slot node its own inline CSS back. */
  reset(): void {
    this.#slotsObserver?.disconnect();
    this.#slotsObserver = null;
    // Drop any fade first: the timeout would otherwise restyle a node whose
    // original `cssText` has just been restored below.
    this.#cancelPosterFade();
    for (const entry of this.#slotted) entry.el.style.cssText = entry.cssText;
    this.#slotted = [];
    this.#poster = null;
    this.#progressBar = null;
    this.#errorSlot = null;
    this.#errorMessage = null;
    this.#setVisible(this.#errorOverlay, false);
    this.#hotspots = [];
    this.#loading = false;
    this.#revealed = true;
    // Teardown: the model is gone, so a host that parked work on
    // `model-visibility` learns about it instead of waiting forever.
    this.#host.onSlotStateChange();
  }
}
