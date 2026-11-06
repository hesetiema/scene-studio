import * as THREE from "three";

export interface AnimationClipInfo {
  /** Stable runtime id: `${objectId}#${index}`. */
  id: string;
  objectId: string;
  index: number;
  name: string;
  duration: number;
}

/** Transport knobs (model-viewer `animation-crossfade-duration` / `pause-at-end`). */
export interface AnimationRigOptions {
  /** Seconds of crossfade when switching clips; `0` = hard cut. */
  crossfadeSeconds?: number;
  /** One-shot playback that holds the last frame instead of looping. */
  pauseAtEnd?: boolean;
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

export interface AnimationRig {
  readonly playing: boolean;
  readonly speed: number;
  /** Playhead of the active clip (seconds). */
  readonly time: number;
  readonly duration: number;
  /** Bind glTF clips to a mounted asset instance (one mixer per object). */
  register(objectId: string, root: THREE.Object3D, clips: readonly unknown[]): void;
  list(): AnimationClipInfo[];
  /** Play one clip (null objectId = first object that has clips). */
  play(objectId: string | null, index?: number): boolean;
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
 * One clip plays at a time across the runtime — a viewer wants a predictable
 * transport, not N mixers drifting apart. `crossfadeSeconds` blends the two
 * clips on the *same* object; across objects the outgoing mixers still stop
 * immediately (there is no meaningful blend between two skeletons).
 */
export function createAnimationRig(): AnimationRig {
  const tracks = new Map<string, Track>();
  let active: ActivePlayback | null = null;
  let playing = false;
  let speed = 1;
  let crossfadeSeconds = 0;
  let pauseAtEnd = false;

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

    const previous = active;
    // Other objects never crossfade: stop their mixers outright.
    for (const other of tracks.values()) {
      if (other !== track) other.mixer.stopAllAction();
    }

    const fade = crossfadeSeconds > 0 && previous !== null && previous.action !== action;
    if (previous && previous.track === track && previous.action !== action) {
      if (fade) previous.action.fadeOut(crossfadeSeconds);
      else previous.action.stop();
    }

    action.reset();
    applyLoopPolicy(action);
    action.enabled = true;
    action.paused = false;
    action.setEffectiveTimeScale(1);
    if (fade) action.fadeIn(crossfadeSeconds);
    else action.setEffectiveWeight(1);
    action.play();

    active = { track, action };
    playing = true;
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
    register(objectId: string, root: THREE.Object3D, clips: readonly unknown[]): void {
      const usable = clips.filter(isAnimationClip);
      if (usable.length === 0) return;
      // A re-register (asset swap) must not leave the old mixer running.
      if (active?.track.objectId === objectId) {
        active = null;
        playing = false;
      }

      const mixer = new THREE.AnimationMixer(root);
      const actions = usable.map((clip) => {
        const action = mixer.clipAction(clip);
        applyLoopPolicy(action);
        return action;
      });
      // One-shot clips end on their own; keep `playing` honest so the runtime
      // can stop its rAF loop instead of rendering a frozen scene forever.
      mixer.addEventListener("finished", (event) => {
        const finished = (event as { action?: THREE.AnimationAction }).action;
        if (!active || active.track.objectId !== objectId) return;
        if (finished && finished !== active.action) return;
        playing = false;
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
        action.reset();
        applyLoopPolicy(action);
      }
      action.paused = false;
      action.enabled = true;
      playing = true;
      track.mixer.update(0);
      return true;
    },
    pause(): void {
      if (active) active.action.paused = true;
      playing = false;
    },
    setSpeed(next: number): void {
      speed = Math.max(0, next);
    },
    setTime(seconds: number): void {
      if (!active) return;
      const { action, track } = active;
      const duration = action.getClip().duration;
      action.time = Math.max(0, Math.min(seconds, duration));
      track.mixer.update(0);
    },
    setOptions(options: AnimationRigOptions): void {
      if (options.crossfadeSeconds !== undefined) {
        crossfadeSeconds = Number.isFinite(options.crossfadeSeconds)
          ? Math.max(0, options.crossfadeSeconds)
          : 0;
      }
      if (options.pauseAtEnd !== undefined) pauseAtEnd = options.pauseAtEnd;
      if (active) applyLoopPolicy(active.action);
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
      playing = false;
    },
  };

  return rig;
}
