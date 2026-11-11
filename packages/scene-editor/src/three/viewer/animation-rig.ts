import * as THREE from "three";
import type { AnimationClipInfo } from "../../runtime/runtime-contract";

// The clip shape is part of the runtime contract (the element exposes it as
// `availableAnimations`); re-exported here so `three-entry` keeps one import.
export type { AnimationClipInfo };

/**
 * Transport notifications — model-viewer's `play` / `pause` / `loop` /
 * `finished` events, minus the DOM. `loop.count` follows the reference: three's
 * mixer counts completed wraps, so the first one reports `1`.
 */
export type AnimationTransportEvent =
  | { type: "play"; objectId: string; index: number; name: string }
  | { type: "pause" }
  | { type: "loop"; count: number; name: string }
  | { type: "finished"; objectId: string; name: string };

/** Transport knobs (model-viewer `animation-crossfade-duration` / `pause-at-end`). */
export interface AnimationRigOptions {
  /** Seconds of crossfade when switching clips; `0` = hard cut. */
  crossfadeSeconds?: number;
  /** One-shot playback that holds the last frame instead of looping. */
  pauseAtEnd?: boolean;
  /**
   * Mirrors playback transitions for the host (`ThreeRuntime` forwards them to
   * its event bus). Called synchronously from the mixer, so keep it cheap.
   */
  onTransport?: (event: AnimationTransportEvent) => void;
}

interface Track {
  objectId: string;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  actions: THREE.AnimationAction[];
}

interface ActivePlayback {
  track: Track;
  action: THREE.AnimationAction;
}

/**
 * One clip in a blend. Weight is a *share*, normalized across the layers of a
 * single call, so `[{0, 1}, {1, 1}]` is a 50/50 blend rather than a 1+1 = 2
 * over-rotation.
 */
export interface AnimationBlendLayer {
  /** Clip index on the target object (as reported by `list()`). */
  index: number;
  /** Relative share of the result; `0` mutes the layer. */
  weight: number;
  /** Per-layer multiplier on top of the global speed (default 1). */
  timeScale?: number;
}

/** Live blend readback — what `blend` returns while playback is active. */
export interface AnimationBlendInfo {
  index: number;
  name: string;
  weight: number;
  timeScale: number;
}

interface Layer {
  track: Track;
  action: THREE.AnimationAction;
  weight: number;
  timeScale: number;
}

export interface AnimationRig {
  readonly playing: boolean;
  readonly speed: number;
  /** Playhead of the primary clip (seconds). */
  readonly time: number;
  readonly duration: number;
  /**
   * Layers of the blend in flight, primary (highest weight) first. One entry
   * for ordinary single-clip playback; empty when nothing is active.
   */
  readonly blend: readonly AnimationBlendInfo[];
  /** Bind glTF clips to a mounted asset instance (one mixer per object). */
  register(objectId: string, root: THREE.Object3D, clips: readonly unknown[]): void;
  list(): AnimationClipInfo[];
  /** Play one clip (null objectId = first object that has clips). */
  play(objectId: string | null, index?: number): boolean;
  /**
   * Play several clips of one object at once, each with a normalized weight.
   * Mixers are shared, so this is a real blend (a walk cycle plus an upper-body
   * gesture), not a crossfade. A single layer is exactly `play()`.
   */
  playBlend(objectId: string | null, layers: readonly AnimationBlendLayer[]): boolean;
  /** Play the first clip whose name matches (case-insensitive); false when absent. */
  playByName(name: string): boolean;
  /** Continue the paused clip without rewinding (finished one-shots restart). */
  resume(): boolean;
  pause(): void;
  setSpeed(speed: number): void;
  /** Scrub the active clip (seconds). */
  setTime(seconds: number): void;
  /** Crossfade / one-shot policy; applies to the clip already playing. */
  setOptions(options: AnimationRigOptions): void;
  /**
   * Property names the clip in flight writes (`<node>.morphTargetInfluences`,
   * `<node>.position`, …). Empty when nothing is playing — manual edits are only
   * ignored while a clip actually drives the channel. Blends report the union.
   */
  activeTrackNames(): string[];
  /** Advance mixers; returns true while playback is active. */
  update(delta: number): boolean;
  dispose(): void;
}

function isAnimationClip(value: unknown): value is THREE.AnimationClip {
  if (typeof value !== "object" || value === null) return false;
  const clip = value as THREE.AnimationClip;
  return typeof clip.duration === "number" && Array.isArray(clip.tracks);
}

/** Within this many seconds of the end, a one-shot clip counts as finished. */
const END_EPSILON = 1e-4;

/**
 * glTF animation playback (reference: `setClips` / `mixer` / `playAllClips`).
 *
 * One *object* plays at a time across the runtime — a viewer wants a predictable
 * transport, not N mixers drifting apart. Within that object, several clips can
 * share the mixer with weights (`playBlend`), which is what glTF's own model
 * supports: one skeleton, N concurrent samplers. `crossfadeSeconds` blends the
 * outgoing playback into the new one on the *same* object; across objects the
 * outgoing mixers still stop immediately (there is no meaningful blend between
 * two skeletons).
 */
export function createAnimationRig(options: AnimationRigOptions = {}): AnimationRig {
  const notify = options.onTransport ?? null;
  const tracks = new Map<string, Track>();
  /** Primary playback — the layer `time` / `duration` / transport events follow. */
  let active: ActivePlayback | null = null;
  /** Every action currently playing on the primary's track (1 for a single clip). */
  let layers: Layer[] = [];
  let playing = false;
  let speed = 1;
  let crossfadeSeconds = 0;
  let pauseAtEnd = false;
  /**
   * Completed wraps of the *active* clip. Reset on every start, like the
   * reference: the first loop of a clip reports `1`, not the clip's lifetime
   * total (three keeps that on the action, which survives a rewind).
   */
  let loopCount = 0;

  /** glTF clips may be unnamed; the reference's `availableAnimations` names them. */
  const clipName = (action: THREE.AnimationAction, index: number): string =>
    action.getClip().name || `Animation ${index + 1}`;

  /** Name of the clip in flight, spelled the same way `list()` spells it. */
  const activeName = (): string => {
    if (!active) return "";
    const index = active.track.actions.indexOf(active.action);
    return clipName(active.action, index < 0 ? 0 : index);
  };

  const applyLoopPolicy = (action: THREE.AnimationAction): void => {
    action.loop = pauseAtEnd ? THREE.LoopOnce : THREE.LoopRepeat;
    action.clampWhenFinished = pauseAtEnd;
  };

  const releaseTrack = (track: Track): void => {
    track.mixer.stopAllAction();
    track.mixer.uncacheRoot(track.root);
  };

  const start = (track: Track, index: number): boolean => {
    const action = track.actions[index];
    if (!action) return false;

    // Other objects never crossfade: stop their mixers outright.
    for (const other of tracks.values()) {
      if (other !== track) other.mixer.stopAllAction();
    }

    const fade =
      crossfadeSeconds > 0 &&
      layers.length > 0 &&
      !(layers.length === 1 && layers[0]!.action === action);
    for (const layer of layers) {
      if (layer.action === action) continue;
      if (fade) layer.action.fadeOut(crossfadeSeconds);
      else layer.action.stop();
    }

    action.reset();
    applyLoopPolicy(action);
    action.enabled = true;
    action.paused = false;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    if (fade) action.fadeIn(crossfadeSeconds);
    action.play();

    active = { track, action };
    layers = [{ track, action, weight: 1, timeScale: 1 }];
    playing = true;
    loopCount = 0;
    notify?.({ type: "play", objectId: track.objectId, index, name: clipName(action, index) });
    return true;
  };

  const rig: AnimationRig = {
    get playing(): boolean {
      return playing;
    },
    get speed(): number {
      return speed;
    },
    get time(): number {
      return active?.action.time ?? 0;
    },
    get duration(): number {
      return active?.action.getClip().duration ?? 0;
    },
    get blend(): readonly AnimationBlendInfo[] {
      return layers.map((layer) => {
        const index = layer.track.actions.indexOf(layer.action);
        return {
          index: index < 0 ? 0 : index,
          name: clipName(layer.action, index < 0 ? 0 : index),
          weight: layer.weight,
          timeScale: layer.timeScale,
        };
      });
    },
    register(objectId: string, root: THREE.Object3D, clips: readonly unknown[]): void {
      const usable = clips.filter(isAnimationClip);
      if (usable.length === 0) return;
      // A re-register (asset swap) must not leave the old mixer running.
      if (active?.track.objectId === objectId) {
        active = null;
        layers = [];
        playing = false;
      }

      const mixer = new THREE.AnimationMixer(root);
      const actions = usable.map((clip) => {
        const action = mixer.clipAction(clip);
        applyLoopPolicy(action);
        return action;
      });
      // Wraps of the clip in flight. three dispatches `loop` for repeat /
      // ping-pong actions only; a `LoopOnce` clip ends with `finished` alone,
      // which is the same split the reference exposes.
      mixer.addEventListener("loop", (event) => {
        const looped = (event as { action?: THREE.AnimationAction }).action;
        if (!active || active.track.objectId !== objectId) return;
        if (looped && looped !== active.action) return;
        loopCount += 1;
        notify?.({ type: "loop", count: loopCount, name: activeName() });
      });
      // One-shot clips end on their own; keep `playing` honest so the runtime
      // can stop its rAF loop instead of rendering a frozen scene forever.
      mixer.addEventListener("finished", (event) => {
        const finished = (event as { action?: THREE.AnimationAction }).action;
        if (!active || active.track.objectId !== objectId) return;
        if (finished && finished !== active.action) return;
        playing = false;
        notify?.({ type: "finished", objectId, name: activeName() });
      });

      const previous = tracks.get(objectId);
      if (previous) releaseTrack(previous);
      tracks.set(objectId, { objectId, root, mixer, clips: usable, actions });
    },
    list(): AnimationClipInfo[] {
      return [...tracks.values()].flatMap((track) =>
        track.clips.map((clip, index) => ({
          id: `${track.objectId}#${index}`,
          objectId: track.objectId,
          index,
          name: clip.name || `Animation ${index + 1}`,
          duration: clip.duration,
        })),
      );
    },
    play(objectId: string | null, index = 0): boolean {
      const track = objectId
        ? tracks.get(objectId)
        : [...tracks.values()].find((candidate) => candidate.clips.length > 0);
      if (!track) return false;
      return start(track, index);
    },
    playBlend(objectId: string | null, requested: readonly AnimationBlendLayer[]): boolean {
      const track = objectId
        ? tracks.get(objectId)
        : [...tracks.values()].find((candidate) => candidate.clips.length > 0);
      if (!track) return false;

      const resolved = requested
        .filter((layer) => Number.isFinite(layer.index))
        .map((layer) => ({
          index: Math.max(0, Math.trunc(layer.index)),
          weight: Number.isFinite(layer.weight) ? Math.max(0, layer.weight) : 0,
          timeScale:
            layer.timeScale !== undefined && Number.isFinite(layer.timeScale)
              ? Math.max(0, layer.timeScale)
              : 1,
        }))
        .filter((layer) => track.actions[layer.index] !== undefined);
      if (resolved.length === 0) return false;
      // One layer is not a blend: keep the plain path (and its events) exact.
      if (resolved.length === 1) return start(track, resolved[0]!.index);

      // Weights are shares: three adds the effective weights, so unnormalized
      // input would scale the pose past what either clip authored.
      const total = resolved.reduce((sum, layer) => sum + layer.weight, 0);
      const share = (weight: number): number =>
        total > 0 ? weight / total : 1 / resolved.length;

      for (const other of tracks.values()) {
        if (other !== track) other.mixer.stopAllAction();
      }
      const fade = crossfadeSeconds > 0 && layers.length > 0;
      const incoming = new Set(resolved.map((layer) => track.actions[layer.index]));

      // Fade out whatever is not part of the new blend; a layer that survives
      // into the next blend is reset below, so it must not be faded out first.
      for (const layer of layers) {
        if (incoming.has(layer.action)) continue;
        if (fade) layer.action.fadeOut(crossfadeSeconds);
        else layer.action.stop();
      }

      const next: Layer[] = [];
      for (const layer of resolved) {
        const action = track.actions[layer.index]!;
        const wasPlaying = layers.some((existing) => existing.action === action);
        action.reset();
        applyLoopPolicy(action);
        action.enabled = true;
        action.paused = false;
        action.setEffectiveTimeScale(layer.timeScale);
        action.setEffectiveWeight(share(layer.weight));
        if (fade && !wasPlaying) action.fadeIn(crossfadeSeconds);
        action.play();
        next.push({
          track,
          action,
          weight: share(layer.weight),
          timeScale: layer.timeScale,
        });
      }

      layers = next;
      // The primary is what transport events and `time` follow: the heaviest
      // layer, first one wins a tie.
      active = next.reduce((best, layer) => (layer.weight > best.weight ? layer : best));
      playing = true;
      loopCount = 0;
      const primaryIndex = track.actions.indexOf(active.action);
      notify?.({
        type: "play",
        objectId: track.objectId,
        index: primaryIndex < 0 ? 0 : primaryIndex,
        name: clipName(active.action, primaryIndex < 0 ? 0 : primaryIndex),
      });
      return true;
    },
    playByName(name: string): boolean {
      const wanted = name.trim().toLowerCase();
      if (!wanted) return false;
      for (const track of tracks.values()) {
        const index = track.clips.findIndex(
          (clip) => (clip.name ?? "").trim().toLowerCase() === wanted,
        );
        if (index >= 0) return start(track, index);
      }
      return false;
    },
    resume(): boolean {
      if (!active) return false;
      const { action, track } = active;
      // A finished one-shot sits clamped on its last frame: rewind before playing.
      if (action.time >= action.getClip().duration - END_EPSILON) {
        for (const layer of layers) {
          layer.action.reset();
          applyLoopPolicy(layer.action);
          layer.action.setEffectiveTimeScale(layer.timeScale);
          layer.action.setEffectiveWeight(layer.weight);
        }
        loopCount = 0;
      }
      for (const layer of layers) {
        layer.action.paused = false;
        layer.action.enabled = true;
      }
      playing = true;
      track.mixer.update(0);
      const index = track.actions.indexOf(action);
      notify?.({ type: "play", objectId: track.objectId, index, name: clipName(action, index) });
      return true;
    },
    pause(): void {
      // The reference stays silent when there was nothing playing: a viewer
      // always starts paused, so a `pause` event there would be noise.
      const wasPlaying = playing;
      for (const layer of layers) layer.action.paused = true;
      playing = false;
      if (wasPlaying) notify?.({ type: "pause" });
    },
    setSpeed(next: number): void {
      speed = Math.max(0, next);
    },
    setTime(seconds: number): void {
      if (!active) return;
      const { track } = active;
      // Every layer of a blend is scrubbed together, each clamped to its own
      // duration: layers of different lengths must stay in sync, not loop.
      for (const layer of layers) {
        const duration = layer.action.getClip().duration;
        layer.action.time = Math.max(0, Math.min(seconds, duration));
      }
      track.mixer.update(0);
    },
    setOptions(options: AnimationRigOptions): void {
      if (options.crossfadeSeconds !== undefined) {
        crossfadeSeconds = Number.isFinite(options.crossfadeSeconds)
          ? Math.max(0, options.crossfadeSeconds)
          : 0;
      }
      if (options.pauseAtEnd !== undefined) pauseAtEnd = options.pauseAtEnd;
      for (const layer of layers) applyLoopPolicy(layer.action);
    },
    activeTrackNames(): string[] {
      if (!playing) return [];
      const names = new Set<string>();
      for (const layer of layers) {
        for (const track of layer.action.getClip().tracks) names.add(track.name);
      }
      return [...names];
    },
    update(delta: number): boolean {
      if (!playing || !active) return false;
      active.track.mixer.update(delta * speed);
      return playing;
    },
    dispose(): void {
      for (const track of tracks.values()) releaseTrack(track);
      tracks.clear();
      active = null;
      layers = [];
      playing = false;
    },
  };

  return rig;
}
