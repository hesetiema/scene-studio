import type {
  MaterialDTO,
  SceneDocument,
  SceneObjectDTO,
  ViewState,
} from "../core/document/schema";
import { createDefaultViewState } from "../core/document/default-view";
import type {
  AnimationClipInfo,
  AnimationOptions,
  AutoRotateOptions,
  CameraControlsOptions,
  EnvironmentPreset,
  MorphTargetInfo,
  RuntimeContract,
  RuntimeEventMap,
  DisplayModeId,
  ToneMappingMode,
  Transform,
} from "./runtime-contract";
import { TypedEventBus } from "./typed-event-bus";

/** Test double implementing RuntimeContract; records every call (D5). */
export class FakeRuntime implements RuntimeContract {
  readonly events = new TypedEventBus();
  readonly calls = {
    loadDocument: [] as SceneDocument[],
    applyTransform: [] as Array<{ id: string; transform: Transform }>,
    clearSelection: 0,
    select: [] as string[][],
    pick: [] as Array<[number, number]>,
    flushDisposers: 0,
    applyViewState: [] as ViewState[],
    autoFrame: 0,
    setToneMapping: [] as ToneMappingMode[],
    setExposure: [] as number[],
    setDisplayMode: [] as DisplayModeId[],
    setExplode: [] as number[],
    addObject: [] as SceneObjectDTO[],
    removeObject: [] as string[],
    reparent: [] as Array<{ id: string; parentId: string | undefined }>,
    setMaterial: [] as Array<{ id: string; material: MaterialDTO | undefined }>,
    exportDocument: [] as Array<{ doc: SceneDocument; format: string }>,
    setCameraControls: [] as CameraControlsOptions[],
    setAutoRotate: [] as Array<AutoRotateOptions | null>,
    setAnimationOptions: [] as AnimationOptions[],
    setEnvironmentPreset: [] as EnvironmentPreset[],
    setEnvironmentImage: [] as Array<string | null>,
    setSkyboxImage: [] as Array<{ url: string | null; asEnvironment: boolean }>,
    frameViewer: 0,
    setInteractive: [] as boolean[],
    setInstancing: [] as boolean[],
    setRenderingPaused: [] as boolean[],
    setCameraByName: [] as Array<string | null>,
    setTouchAction: [] as string[],
    resetTurntableRotation: 0,
    resetTurntableThetas: [] as number[],
    smoothViewTo: [] as Array<{ view: ViewState["camera"]; decayMs: number }>,
    jumpCameraToGoal: 0,
    playAnimation: [] as Array<{ objectId: string | null; index: number }>,
    playAnimationByName: [] as string[],
    pauseAnimations: 0,
    resumeAnimations: 0,
    setAnimationTime: [] as number[],
    setAnimationSpeed: [] as number[],
    setMorphInfluence: [] as Array<{
      objectId: string;
      meshIndex: number;
      targetIndex: number;
      value: number;
    }>,
  };
  /** Names `setCameraByName` will report as found. */
  camerasList: string[] = [];
  /** Channels `morphTargets` reports; `setMorphInfluence` honours `driven`. */
  morphList: MorphTargetInfo[] = [];
  /** Clips the transport reports; `playAnimation` resolves against them. */
  clips: AnimationClipInfo[] = [];
  #cameraName: string | null = null;
  #playing = false;
  #time = 0;
  #speed = 1;
  #active: AnimationClipInfo | null = null;
  pickResult: string | null = null;
  /** When true, applyViewState re-emits view-change (contract-violation probe). */
  viewChangeOnApply = false;
  #view: ViewState = createDefaultViewState();
  #liveViewEvents = false;

  async loadDocument(doc: SceneDocument): Promise<void> {
    this.calls.loadDocument.push(doc);
    // Mirrors ThreeRuntime: one progress ramp per load, then a `load` edge.
    this.events.emit("load-progress", { totalProgress: 0, reason: "model-load" });
    this.events.emit("load-progress", { totalProgress: 1, reason: "model-load" });
    this.events.emit("load", { sceneId: doc.sceneId });
  }

  applyTransform(id: string, transform: Transform): void {
    this.calls.applyTransform.push({ id, transform });
  }

  addObject(dto: SceneObjectDTO): void {
    this.calls.addObject.push(structuredClone(dto));
  }

  removeObject(id: string): void {
    this.calls.removeObject.push(id);
  }

  reparent(id: string, parentId: string | undefined): void {
    this.calls.reparent.push({ id, parentId });
  }

  setMaterial(id: string, material: MaterialDTO | undefined): void {
    this.calls.setMaterial.push({
      id,
      material: material === undefined ? undefined : structuredClone(material),
    });
  }

  clearSelection(): void {
    this.calls.clearSelection += 1;
  }

  select(ids: string[]): void {
    this.calls.select.push([...ids]);
  }

  pick(clientX: number, clientY: number): string | null {
    this.calls.pick.push([clientX, clientY]);
    return this.pickResult;
  }

  flushDisposers(): void {
    this.calls.flushDisposers += 1;
  }

  getViewState(): ViewState {
    return structuredClone(this.#view);
  }

  applyViewState(view: ViewState): void {
    this.calls.applyViewState.push(structuredClone(view));
    this.#view = structuredClone(view);
    if (this.viewChangeOnApply) this.events.emit("view-change", { view: this.getViewState() });
  }

  /** Test helper: pretend the user moved the camera. */
  simulateViewChange(view: ViewState): void {
    this.#view = structuredClone(view);
    const payload: RuntimeEventMap["view-change"] = { view: this.getViewState() };
    this.events.emit("view-change", payload);
  }

  /** Live sampling is opt-in, mirroring ThreeRuntime. */
  setLiveViewEvents(enabled: boolean): void {
    this.#liveViewEvents = enabled;
  }

  autoFrame(): void {
    this.calls.autoFrame += 1;
  }

  frameViewer(): void {
    this.calls.frameViewer += 1;
    // The viewer framing is an `autoFrame()` with model-viewer's FOV rule.
    this.autoFrame();
  }

  /** Authoring chrome on/off (the element drives this from `mode`). */
  setInteractive(interactive: boolean): void {
    this.calls.setInteractive.push(interactive);
  }

  /** Draw-call batching on/off (the element drives this from `instancing`). */
  setInstancing(enabled: boolean): void {
    this.calls.setInstancing.push(enabled);
  }

  setRenderingPaused(paused: boolean): void {
    this.calls.setRenderingPaused.push(paused);
  }

  get cameras(): string[] {
    return [...this.camerasList];
  }

  get cameraName(): string | null {
    return this.#cameraName;
  }

  setCameraByName(name: string | null): boolean {
    this.calls.setCameraByName.push(name);
    if (name === null) {
      this.#cameraName = null;
      return true;
    }
    // Mirrors ThreeRuntime: unknown names are remembered, not applied.
    if (!this.camerasList.includes(name)) return false;
    this.#cameraName = name;
    return true;
  }

  get morphTargets(): MorphTargetInfo[] {
    return this.morphList.map((entry) => ({ ...entry }));
  }

  setMorphInfluence(
    objectId: string,
    meshIndex: number,
    targetIndex: number,
    value: number,
  ): boolean {
    this.calls.setMorphInfluence.push({ objectId, meshIndex, targetIndex, value });
    const channel = this.morphList.find(
      (entry) =>
        entry.objectId === objectId &&
        entry.meshIndex === meshIndex &&
        entry.targetIndex === targetIndex,
    );
    if (!channel || channel.driven) return false;
    channel.influence = value;
    return true;
  }

  setToneMapping(mode: ToneMappingMode): void {
    this.calls.setToneMapping.push(mode);
  }

  /** Records the call and returns a stand-in Blob (no serialization in doubles). */
  async exportDocument(
    doc: SceneDocument,
    options: { format?: "glb" | "gltf" | "obj" } = {},
  ): Promise<Blob> {
    this.calls.exportDocument.push({ doc, format: options.format ?? "glb" });
    return new Blob(["fake-export"], { type: "model/gltf-binary" });
  }

  setExposure(value: number): void {
    this.calls.setExposure.push(value);
  }

  #displayMode: DisplayModeId = "studio";

  setDisplayMode(mode: DisplayModeId): void {
    this.calls.setDisplayMode.push(mode);
    this.#displayMode = mode;
  }

  get displayMode(): DisplayModeId {
    return this.#displayMode;
  }

  #explode = 0;

  setExplode(factor: number): void {
    this.calls.setExplode.push(factor);
    this.#explode = Math.min(1, Math.max(0, factor));
  }

  get explode(): number {
    return this.#explode;
  }

  setEnvironmentPreset(preset: EnvironmentPreset): void {
    this.calls.setEnvironmentPreset.push(preset);
  }

  setEnvironmentImage(url: string | null): void {
    this.calls.setEnvironmentImage.push(url);
  }

  setSkyboxImage(url: string | null, options: { asEnvironment: boolean }): void {
    this.calls.setSkyboxImage.push({ url, asEnvironment: options.asEnvironment });
  }

  setCameraControls(options: CameraControlsOptions): void {
    this.calls.setCameraControls.push(structuredClone(options));
  }

  setAutoRotate(options: AutoRotateOptions | null): void {
    this.calls.setAutoRotate.push(options === null ? null : { ...options });
  }

  resetTurntableRotation(theta?: number): void {
    this.calls.resetTurntableRotation += 1;
    this.calls.resetTurntableThetas.push(theta ?? 0);
  }

  smoothViewTo(view: ViewState["camera"], decayMs: number): void {
    this.calls.smoothViewTo.push({ view: structuredClone(view), decayMs });
    // Nothing to animate here: land on the goal at once, so the element's
    // getters (`getCameraOrbit`, `getFieldOfView`) read the new pose.
    this.applyViewState({ ...this.getViewState(), camera: structuredClone(view) });
  }

  jumpCameraToGoal(): void {
    this.calls.jumpCameraToGoal += 1;
  }

  setTouchAction(value: string): void {
    this.calls.setTouchAction.push(value);
  }

  setAnimationOptions(options: AnimationOptions): void {
    this.calls.setAnimationOptions.push({ ...options });
  }

  /* ------------------------------------------------------------- transport ---- */

  get animations(): AnimationClipInfo[] {
    return this.clips.map((clip) => ({ ...clip }));
  }

  get animationPlaying(): boolean {
    return this.#playing;
  }

  get animationTime(): number {
    return this.#time;
  }

  get animationDuration(): number {
    return this.#active?.duration ?? 0;
  }

  get animationSpeed(): number {
    return this.#speed;
  }

  playAnimation(objectId: string | null = null, index = 0): boolean {
    this.calls.playAnimation.push({ objectId, index });
    const clip =
      objectId === null
        ? this.clips[0]
        : this.clips.find((entry) => entry.objectId === objectId && entry.index === index);
    if (!clip) return false;
    this.#active = clip;
    this.#playing = true;
    this.#time = 0;
    return true;
  }

  playAnimationByName(name: string): boolean {
    this.calls.playAnimationByName.push(name);
    const wanted = name.trim().toLowerCase();
    const clip = this.clips.find((entry) => entry.name.toLowerCase() === wanted);
    if (!clip) return false;
    this.#active = clip;
    this.#playing = true;
    this.#time = 0;
    return true;
  }

  pauseAnimations(): void {
    this.calls.pauseAnimations += 1;
    this.#playing = false;
  }

  resumeAnimations(): boolean {
    this.calls.resumeAnimations += 1;
    if (!this.#active) return false;
    this.#playing = true;
    return true;
  }

  setAnimationTime(seconds: number): void {
    this.calls.setAnimationTime.push(seconds);
    this.#time = seconds;
  }

  setAnimationSpeed(speed: number): void {
    this.calls.setAnimationSpeed.push(speed);
    this.#speed = speed;
  }

  get liveViewEvents(): boolean {
    return this.#liveViewEvents;
  }

  /** Test helper: pretend the camera moved (auto-rotate / damping sample). */
  simulateCameraChange(camera: ViewState["camera"]): void {
    this.events.emit("camera-change", structuredClone(camera));
  }

  /** Test helper: in-flight sample; a no-op unless live sampling is enabled. */
  simulateViewChanging(view: ViewState): void {
    if (!this.#liveViewEvents) return;
    this.#view = structuredClone(view);
    const payload: RuntimeEventMap["view-changing"] = { view: this.getViewState() };
    this.events.emit("view-changing", payload);
  }
}
