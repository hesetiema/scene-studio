import * as THREE from "three";
import type { ViewState } from "../../core/document/schema";
import type { AutoRotateOptions, CameraControlsOptions } from "../../runtime/runtime-contract";
import { createTouchActionOwner } from "./touch-action-owner";

/** Minimal OrbitControls surface the runtime needs (real or injected, D22). */
export interface OrbitControlsLike {
  update?: () => void;
  dispose: () => void;
  target?: THREE.Vector3;
  addEventListener?: (type: string, handler: () => void) => void;
  /* Optional knobs — an injected stub may omit any of them. */
  enablePan?: boolean;
  enableZoom?: boolean;
  minDistance?: number;
  maxDistance?: number;
  minPolarAngle?: number;
  maxPolarAngle?: number;
  minAzimuthAngle?: number;
  maxAzimuthAngle?: number;
  enableDamping?: boolean;
  dampingFactor?: number;
}

export type CameraView = ViewState["camera"];

export interface CameraRigOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  /** Injectable seam: defaults to three's OrbitControls, lazily imported. */
  orbitControlsFactory?: (
    camera: THREE.Camera,
    domElement: HTMLElement,
  ) => OrbitControlsLike | null;
  onRender: () => void;
  /** Fired once per user gesture end — the only source of `view-change` (D22). */
  onInteractionEnd: () => void;
}

export interface CameraRig {
  readonly orbit: OrbitControlsLike | null;
  /** Orbit target, or the remembered fallback when controls are absent. */
  readonly target: THREE.Vector3;
  /** Attach an already-created OrbitControls (injected or lazily imported). */
  mount(orbit: OrbitControlsLike | null): void;
  /** Lazily import three's OrbitControls and mount it. Never rejects. */
  mountDefault(): Promise<void>;
  /** Pointer policy + orbit limits (model-viewer `disable-*` / `min-max-camera-orbit`). */
  applyControls(options: CameraControlsOptions): void;
  /** Turntable rotation; `null` stops it. Survives a late controls mount. */
  setAutoRotate(options: AutoRotateOptions | null): void;
  /**
   * Undo the yaw the turntable has accumulated so far (model-viewer
   * `resetTurntableRotation()`): the model faces front again without disturbing
   * the orbit the user dragged to. No-op when the turntable never ran.
   */
  resetTurntableRotation(theta?: number): void;
  /**
   * Gate both rAF loops (turntable + damping settle) without dropping their
   * configuration — used when the viewer goes off-screen.
   */
  setActive(active: boolean): void;
  readView(): CameraView;
  applyView(view: CameraView): void;
  /**
   * Ease to `view` instead of snapping (model-viewer's `interpolation-decay`:
   * asymptotic, `decayMs` is where most of the motion happens). The camera
   * arcs around the target rather than cutting through it.
   */
  easeTo(view: CameraView, decayMs: number): void;
  /** Land on a running ease's goal right now (model-viewer `jumpCameraToGoal`). */
  finishEase(): void;
  /**
   * CSS `touch-action` for the canvas. The addon hard-codes `none` when it
   * connects (`OrbitControls`: "Disable touch scroll"), so a viewer that wants
   * page scroll back has to re-assert its value afterwards — which is why this
   * lives on the rig rather than in the element's DOM code.
   */
  setTouchAction(value: string | null): void;
  /** Keep the target in sync when no controls exist (headless / disabled, D22). */
  setTarget(target: readonly [number, number, number]): void;
  dispose(): void;
}

const DEG_TO_RAD = Math.PI / 180;
/** model-viewer's `rotation-per-second` default. */
const DEFAULT_DEGREES_PER_SECOND = 30;
/** Clamp a stalled frame so a backgrounded tab cannot spin the model 180°. */
const MAX_STEP_SECONDS = 0.1;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Camera + OrbitControls ownership (reference: `defaultCamera` / `controls`).
 *
 * The addon may mount *after* a document applied its `view`; without re-seeding
 * the target it would re-derive the camera around (0,0,0) and throw away the
 * restored framing (showed up as flaky first-frame camera in the visual gate).
 *
 * Auto-rotate is a yaw of the camera around the orbit target, stepped from a
 * rAF loop with a real delta. Doing it by hand (instead of OrbitControls'
 * `autoRotate`) keeps the speed honest: the addon's per-frame rotation assumes
 * 60fps and this rig renders on demand, so its speed would drift with the
 * display.
 */
export function createCameraRig(options: CameraRigOptions): CameraRig {
  const { camera } = options;
  const fallbackTarget = new THREE.Vector3(0, 0, 0);
  let orbit: OrbitControlsLike | null = null;
  let controls: CameraControlsOptions = {};
  let autoRotate: Required<AutoRotateOptions> | null = null;
  let frame: number | null = null;
  let lastTick = 0;
  let resumeAt = 0;
  let interacting = false;
  let disposed = false;
  /** Off-screen gate: loops stop but keep their configuration. */
  let active = true;
  /** Damping settle loop: separate from the turntable loop both may want. */
  let settleFrame: number | null = null;
  /** Set by the controls' `change` event; read once per settle frame. */
  let movedThisFrame = false;
  /** Requested `touch-action`; re-applied whenever the addon grabs the canvas. */
  let touchAction: string | null = null;
  /** Holds that value against the orbit and gizmo addons (see the module). */
  const touchActionOwner = createTouchActionOwner(options.domElement);
  /**
   * Net yaw the turntable has applied since the last reset. Kept apart from the
   * user's orbit so `resetTurntableRotation()` can roll back only our share.
   */
  let turntableRadians = 0;

  const applyToOrbit = (): void => {
    if (!orbit) return;
    if (controls.pan !== undefined) orbit.enablePan = controls.pan;
    if (controls.zoom !== undefined) orbit.enableZoom = controls.zoom;

    // Inertia: the addon only decays its spherical delta inside `update()`, so
    // a render-on-demand viewer needs the settle loop below to keep feeding it
    // frames after the pointer lifts.
    if (controls.damping !== undefined) {
      orbit.enableDamping = controls.damping > 0;
      if (controls.damping > 0) orbit.dampingFactor = controls.damping;
    }

    const limits = controls.limits;
    if (!limits) return;
    if (limits.radius) {
      orbit.minDistance = limits.radius[0];
      orbit.maxDistance = limits.radius[1];
    }
    if (limits.phi) {
      orbit.minPolarAngle = limits.phi[0] * DEG_TO_RAD;
      orbit.maxPolarAngle = limits.phi[1] * DEG_TO_RAD;
    }
    if (limits.theta) {
      orbit.minAzimuthAngle = limits.theta[0] * DEG_TO_RAD;
      orbit.maxAzimuthAngle = limits.theta[1] * DEG_TO_RAD;
    }
  };

  /**
   * Win the `touch-action` argument with the addons.
   *
   * `OrbitControls` and `TransformControls` both write `none` onto the canvas
   * when they connect, which silently cancels a viewer's `touch-action="pan-y"`.
   * Neither connect is ours to sequence (both addons arrive from dynamic
   * imports), so the value is owned rather than re-asserted once — see
   * `touch-action-owner.ts`. Nothing is written while the element has not opted
   * in, so a viewer that never sets the attribute keeps the addons' behaviour.
   */
  const applyTouchAction = (): void => {
    if (touchAction === null) return;
    touchActionOwner.set(touchAction);
  };

  const stopAutoRotate = (): void => {
    if (frame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    }
    frame = null;
  };

  const stopSettle = (): void => {
    if (settleFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(settleFrame);
    }
    settleFrame = null;
  };

  /**
   * Feed OrbitControls frames until its damped motion falls under the addon's
   * own epsilon (it stops dispatching `change`, which is what we watch).
   *
   * The rig never calls `update()` here: `onRender` → render loop → `update()`
   * is the single per-frame step, so damping is not decayed twice per frame.
   */
  const settleTick = (): void => {
    settleFrame = null;
    if (disposed || !active || interacting) return;
    movedThisFrame = false;
    options.onRender();
    if (!movedThisFrame) return;
    settleFrame =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(settleTick) : null;
  };

  const startSettle = (): void => {
    if (disposed || !active || interacting || settleFrame !== null) return;
    if (!orbit?.enableDamping) return;
    if (typeof requestAnimationFrame !== "function") return;
    movedThisFrame = false;
    settleFrame = requestAnimationFrame(settleTick);
  };

  const rotateYaw = (radians: number): void => {
    if (radians === 0) return;
    const target = orbit?.target ?? fallbackTarget;
    const offset = camera.position.clone().sub(target);
    offset.applyAxisAngle(Y_AXIS, radians);
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
  };

  /* ------------------------------------------------------------- pose ease */

  /** model-viewer's own default for `interpolation-decay`. */
  const DEFAULT_DECAY_MS = 50;
  /** Below this, a fade is done: snapping beats one more sub-pixel frame. */
  const EASE_EPSILON = 0.001;
  const IDENTITY = new THREE.Quaternion();

  interface EaseState {
    from: CameraView;
    to: CameraView;
    decayMs: number;
    startedAt: number;
    frame: number | null;
  }

  let ease: EaseState | null = null;

  const sameView = (a: CameraView, b: CameraView): boolean =>
    a.position.every((value, index) => Math.abs(value - b.position[index]!) < 1e-6) &&
    a.target.every((value, index) => Math.abs(value - b.target[index]!) < 1e-6) &&
    Math.abs(a.fov - b.fov) < 1e-6;

  /**
   * Put the camera at `p` of the way from `from` to `to`.
   *
   * The eye is interpolated on the sphere around the (also interpolated) target,
   * so a 180° orbit sweeps around the model instead of diving through it — the
   * same reason model-viewer slerps rather than lerping positions.
   */
  const blendView = (from: CameraView, to: CameraView, p: number): CameraView => {
    const fromTarget = new THREE.Vector3(...from.target);
    const toTarget = new THREE.Vector3(...to.target);
    const target = fromTarget.clone().lerp(toTarget, p);

    const fromOffset = new THREE.Vector3(...from.position).sub(fromTarget);
    const toOffset = new THREE.Vector3(...to.position).sub(toTarget);
    const fromRadius = fromOffset.length();
    const toRadius = toOffset.length();
    const radius = fromRadius + (toRadius - fromRadius) * p;

    let direction: THREE.Vector3;
    if (fromRadius < 1e-6 || toRadius < 1e-6) {
      // Degenerate (eye sitting on the target): no arc to follow.
      direction = toOffset.clone().normalize();
    } else {
      const turn = new THREE.Quaternion().setFromUnitVectors(
        fromOffset.normalize(),
        toOffset.normalize(),
      );
      direction = fromOffset
        .clone()
        .applyQuaternion(new THREE.Quaternion().slerpQuaternions(IDENTITY, turn, p));
    }

    const position = target.clone().addScaledVector(direction, radius);
    return {
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
      fov: from.fov + (to.fov - from.fov) * p,
    };
  };

  const applyCameraView = (view: CameraView): void => {
    const [x, y, z] = view.position;
    const [tx, ty, tz] = view.target;
    camera.position.set(x, y, z);
    camera.fov = view.fov;
    camera.lookAt(tx, ty, tz);
    camera.updateProjectionMatrix();
    rig.setTarget(view.target);
  };

  const stopEase = (): void => {
    if (ease?.frame != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(ease.frame);
    }
    ease = null;
  };

  /**
   * A pose fade is ownerless: it is not part of the document and not a gesture,
   * so it is dropped by anything that takes the camera over — a drag, a restored
   * view, or teardown.
   */
  const easeTick = (now: number): void => {
    if (!ease) return;
    const state = ease;
    state.frame = null;
    if (disposed) {
      stopEase();
      return;
    }

    // Asymptotic, like model-viewer: `1 - e^-t` puts ~95% of the motion inside
    // one `interpolation-decay`, and doubling the decay halves the speed. The
    // progress is deliberately *not* clamped at 1 — the snap below needs the
    // asymptote to actually approach its limit.
    const elapsed = Math.max(0, now - state.startedAt);
    const p = 1 - Math.exp((-3 * elapsed) / state.decayMs);

    if (p >= 1 - EASE_EPSILON) {
      applyCameraView(state.to);
      ease = null;
      options.onRender();
      // The turntable was parked for the fade; hand the camera back.
      startAutoRotate();
      return;
    }

    applyCameraView(blendView(state.from, state.to, p));
    options.onRender();
    state.frame =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(easeTick) : null;
  };

  const startEase = (from: CameraView, to: CameraView, decayMs: number): void => {
    stopEase();
    // Two loops cannot own the camera: the turntable waits for the fade.
    stopAutoRotate();
    if (typeof requestAnimationFrame !== "function") {
      applyCameraView(to);
      options.onRender();
      startAutoRotate();
      return;
    }
    ease = {
      from,
      to,
      decayMs: Number.isFinite(decayMs) && decayMs > 0 ? decayMs : DEFAULT_DECAY_MS,
      startedAt: nowMs(),
      frame: null,
    };
    options.onRender();
    ease.frame = requestAnimationFrame(easeTick);
  };

  const tick = (now: number): void => {
    frame = null;
    if (disposed || !active || !autoRotate?.enabled) return;

    // A drag owns the camera; `end` restarts the loop after the idle delay.
    if (interacting) return;

    const delta = Math.min(Math.max(0, now - lastTick) / 1000, MAX_STEP_SECONDS);
    lastTick = now;

    if (now >= resumeAt) {
      const step = autoRotate.degreesPerSecond * DEG_TO_RAD * delta;
      rotateYaw(step);
      turntableRadians += step;
      // Rendering re-runs `OrbitControls.update()`, which re-derives its
      // spherical state from the camera and enforces the limits.
      options.onRender();
    }

    frame =
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(tick) : null;
  };

  const startAutoRotate = (): void => {
    if (disposed || !active || frame !== null || !autoRotate?.enabled) return;
    if (typeof requestAnimationFrame !== "function") return;
    lastTick = nowMs();
    frame = requestAnimationFrame(tick);
  };

  const rig: CameraRig = {
    get orbit(): OrbitControlsLike | null {
      return orbit;
    },
    get target(): THREE.Vector3 {
      return orbit?.target ?? fallbackTarget;
    },
    mount(next: OrbitControlsLike | null): void {
      orbit = next;
      if (!next) return;
      next.target?.set(fallbackTarget.x, fallbackTarget.y, fallbackTarget.z);
      next.addEventListener?.("change", () => {
        movedThisFrame = true;
        options.onRender();
      });
      next.addEventListener?.("start", () => {
        interacting = true;
        // The pointer wins over an in-flight pose fade.
        stopEase();
        stopSettle();
      });
      next.addEventListener?.("end", () => {
        interacting = false;
        // model-viewer's `auto-rotate-delay`: idle before the turntable resumes.
        resumeAt = nowMs() + (autoRotate?.delayMs ?? 0);
        startSettle();
        startAutoRotate();
        options.onInteractionEnd();
      });
      applyToOrbit();
      // The addon just claimed `touch-action: none`; put ours back.
      applyTouchAction();
      options.onRender();
    },
    async mountDefault(): Promise<void> {
      try {
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        rig.mount(
          new OrbitControls(camera, options.domElement) as unknown as OrbitControlsLike,
        );
      } catch {
        // optional addon unavailable — a controls-less runtime still works
      }
    },
    applyControls(next: CameraControlsOptions): void {
      controls = { ...controls, ...next };
      applyToOrbit();
      options.onRender();
    },
    setAutoRotate(next: AutoRotateOptions | null): void {
      if (!next?.enabled) {
        autoRotate = null;
        stopAutoRotate();
        return;
      }
      autoRotate = {
        enabled: true,
        degreesPerSecond: Number.isFinite(next.degreesPerSecond)
          ? (next.degreesPerSecond as number)
          : DEFAULT_DEGREES_PER_SECOND,
        delayMs: Number.isFinite(next.delayMs) ? Math.max(0, next.delayMs as number) : 0,
      };
      resumeAt = Math.max(resumeAt, nowMs());
      startAutoRotate();
    },
    resetTurntableRotation(theta = 0): void {
      // model-viewer's semantics: after the call the turntable reads `theta`,
      // so this rolls back the difference rather than blindly zeroing.
      const goal = Number.isFinite(theta) ? theta : 0;
      const delta = goal - turntableRadians;
      if (delta === 0) return;
      rotateYaw(delta);
      turntableRadians = goal;
      options.onRender();
    },
    setTouchAction(value: string | null): void {
      touchAction = value;
      applyTouchAction();
    },
    setActive(next: boolean): void {
      if (next === active) return;
      active = next;
      if (!next) {
        stopAutoRotate();
        stopSettle();
        // Land on the goal *without* rendering: a viewer that just left the
        // screen (or lost its tab) must not paint one more frame.
        if (ease) {
          const goal = ease.to;
          stopEase();
          applyCameraView(goal);
        }
        return;
      }
      // Turntable picks up where it left off; a stale settle is only worth
      // resuming if the controls still report inertia, which one frame answers.
      startAutoRotate();
      startSettle();
    },
    readView(): CameraView {
      const target = rig.target;
      return {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [target.x, target.y, target.z],
        fov: camera.fov,
      };
    },
    applyView(view: CameraView): void {
      // A restored view is authoritative: an in-flight fade would keep pulling
      // the camera away from it.
      stopEase();
      const [x, y, z] = view.position;
      const [tx, ty, tz] = view.target;
      camera.position.set(x, y, z);
      camera.fov = view.fov;
      camera.lookAt(tx, ty, tz);
      camera.updateProjectionMatrix();
      // A restored view is the new baseline: rolling the turntable back from
      // here would drag the document's own pose off-centre.
      turntableRadians = 0;
      rig.setTarget(view.target);
      // If a fade parked the turntable, give it back.
      startAutoRotate();
    },
    easeTo(view: CameraView, decayMs: number): void {
      const from = rig.readView();
      // Already there: no fade, no loop, no wasted frames.
      if (sameView(from, view)) return;
      startEase(from, view, decayMs);
    },
    finishEase(): void {
      if (!ease) return;
      const goal = ease.to;
      stopEase();
      applyCameraView(goal);
      options.onRender();
      startAutoRotate();
    },
    setTarget(target: readonly [number, number, number]): void {
      const [x, y, z] = target;
      fallbackTarget.set(x, y, z);
      orbit?.target?.set(x, y, z);
    },
    dispose(): void {
      disposed = true;
      autoRotate = null;
      stopAutoRotate();
      stopSettle();
      stopEase();
      orbit?.dispose();
      orbit = null;
      touchActionOwner.dispose();
    },
  };

  return rig;
}
