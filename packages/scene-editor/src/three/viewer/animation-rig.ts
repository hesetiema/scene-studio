import * as THREE from "three";

export interface AnimationClipInfo {
  /** Stable runtime id: `${objectId}#${index}`. */
  id: string;
  objectId: string;
  index: number;
  name: string;
  duration: number;
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
  /** Continue the paused clip without rewinding. */
  resume(): boolean;
  pause(): void;
  setSpeed(speed: number): void;
  /** Scrub the active clip (seconds). */
  setTime(seconds: number): void;
  /** Advance mixers; returns true while playback is active. */
  update(delta: number): boolean;
  dispose(): void;
}

function isAnimationClip(value: unknown): value is THREE.AnimationClip {
  if (typeof value !== "object" || value === null) return false;
  const clip = value as THREE.AnimationClip;
  return typeof clip.duration === "number" && Array.isArray(clip.tracks);
}

/**
 * glTF animation playback (reference: `setClips` / `mixer` / `playAllClips`).
 *
 * One clip plays at a time across the runtime — a viewer wants a predictable
 * transport, not N mixers drifting apart.
 */
export function createAnimationRig(): AnimationRig {
  const tracks = new Map<string, Track>();
  let active: ActivePlayback | null = null;
  let playing = false;
  let speed = 1;

  const releaseTrack = (track: Track): void => {
    track.mixer.stopAllAction();
    track.mixer.uncacheRoot(track.root);
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
      const mixer = new THREE.AnimationMixer(root);
      const actions = usable.map((clip) => {
        const action = mixer.clipAction(clip);
        action.loop = THREE.LoopRepeat;
        action.clampWhenFinished = false;
        return action;
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
      const action = track.actions[index];
      if (!action) return false;
      for (const other of tracks.values()) other.mixer.stopAllAction();
      active = { track, action: action.reset() };
      action.paused = false;
      action.enabled = true;
      action.play();
      playing = true;
      return true;
    },
    resume(): boolean {
      if (!active) return false;
      active.action.paused = false;
      active.action.enabled = true;
      playing = true;
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
    update(delta: number): boolean {
      if (!playing || !active) return false;
      active.track.mixer.update(delta * speed);
      return true;
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
