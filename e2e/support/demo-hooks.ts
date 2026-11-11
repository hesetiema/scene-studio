/**
 * Typed handles for the `window.__*` hooks the `?demo=` scenarios expose.
 *
 * Keeping them in one module (instead of `declare global` in each spec) means
 * both the coverage and the adversarial suites describe the same contract.
 */

export interface HostApiState {
  selected: string[];
  dirty: boolean;
  revision: number;
  serverRevision: number;
  canUndo: boolean;
  canRedo: boolean;
  labels: Record<string, string>;
  conflict: { base: number; incoming: number; local: number } | null;
}

export interface HostApiDemoHook {
  state: () => HostApiState;
  actions: {
    selectAll: () => void;
    selectBox2: () => void;
    toggleBox2: () => void;
    tag: () => void;
    undo: () => void;
    redo: () => void;
    localEdit: () => void;
    pushRemote: () => Promise<string>;
    takeRemote: () => Promise<void>;
    keepLocal: () => void;
    reloadBase: () => Promise<void>;
    save: () => void;
  };
}

export interface DemoResult {
  ok: boolean;
  code?: string;
  message?: string;
  schemaVersion?: number;
  objectCount?: number;
  applied?: Array<{ from: number; to: number }>;
  [key: string]: unknown;
}

export interface DocumentDemoHook {
  last: () => DemoResult | null;
  run: {
    migrate: () => DemoResult;
    validate: () => DemoResult;
    badHierarchy: () => DemoResult;
    badColor: () => DemoResult;
    badVersion: () => DemoResult;
    importDoc: () => Promise<DemoResult>;
  };
  state: () => { loaded: boolean; revision: number; sceneId: string };
}

export interface CoverageReport {
  passed: number;
  failed: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface AssetsState {
  loaded: boolean;
  sceneId: string;
  resolved: string[];
  errors: Array<{ code: string; message: string }>;
  meshCount: number;
  objectCount: number;
}

export interface AssetsDemoHook {
  state: () => AssetsState;
  actions: {
    loadTri: () => Promise<{ ok: boolean; code?: string }>;
    loadDraco: () => Promise<{ ok: boolean; code?: string }>;
    loadMissing: () => Promise<{ ok: boolean; code?: string }>;
    loadUnsupported: () => Promise<{ ok: boolean; code?: string }>;
    runCache: () => Promise<Record<string, unknown>>;
    loadFile: () => Promise<{ ok: boolean; meshCount: number; objects: number }>;
    exportGlb: () => Promise<{ size: number; type: string }>;
  };
  makeDoc: (assetId: string, sceneId?: string) => unknown;
}

export interface ViewerState {
  src: string;
  loading: string;
  loaded: boolean;
  clips: string[];
  clipName: string | null;
  autoplay: boolean;
  playing: boolean;
  crossfadeMs: number;
  pauseAtEnd: boolean;
  autoRotate: boolean;
  rotationPerSecond: number;
  limits: "free" | "horizontal" | "eye";
  disabled: { pan: boolean; zoom: boolean; tap: boolean };
  background: string | null;
  gridVisible: boolean;
  contactShadow: boolean;
  cameraChanges: number;
  environmentChanges: number;
  modelVisible: boolean | null;
  probeLoaded: boolean;
  cameras: string[];
  cameraName: string | null;
  morphs: Array<{ name: string; influence: number; driven: boolean }>;
  availableAnimations: string[];
  paused: boolean;
  currentTime: number;
  duration: number;
  timeScale: number;
  orbit: { theta: number; phi: number; radius: number } | null;
  fov: number;
  alt: string | null;
  orbitSensitivity: number;
  touchAction: string;
  interpolationDecay: number;
  environmentImage: string | null;
  skyboxImage: string | null;
  withCredentials: boolean;
  environmentMapId: string | null;
  backgroundIsTexture: boolean;
}

export interface ViewerDemoHook {
  state: () => ViewerState;
  actions: {
    setModel: (id: "fox" | "helmet" | "truck" | "fixture") => void;
    setLimits: (preset: "free" | "horizontal" | "eye") => void;
    setLoading: (mode: "eager" | "lazy") => void;
    toggle: (id: string, on: boolean) => void;
    setTransparent: (on: boolean) => void;
    setGrid: (on: boolean) => void;
    setContactShadow: (on: boolean) => void;
    setSpeed: (degreesPerSecond: number) => void;
    setDelay: (ms: number) => void;
    setClip: (name: string) => void;
    setCrossfade: (ms: number) => void;
    setToneMapping: (mode: string) => void;
    setExposure: (value: number) => void;
    resetCamera: () => void;
    scrollToProbe: () => void;
    setCamera: (name: string | null) => void;
    setMorph: (index: number, value: number) => void;
    setDamping: (on: boolean) => void;
    play: () => boolean;
    pause: () => void;
    seek: (seconds: number) => void;
    setTimeScale: (value: number) => void;
    setOrbit: (orbit: { theta?: number; phi?: number; radius?: number }) => void;
    setFieldOfView: (degrees: number) => void;
    setOrbitSensitivity: (value: number) => void;
    setTouchAction: (value: string) => void;
    setInterpolationDecay: (ms: number) => void;
    jumpCamera: () => boolean;
    setEnvironment: (environmentImage: string | null, skyboxImage: string | null) => void;
    setWithCredentials: (on: boolean) => void;
    resetTurntable: (theta?: number) => boolean;
  };
}

declare global {
  interface Window {
    __demo: HostApiDemoHook;
    __docDemo: DocumentDemoHook;
    __coverage: { report: () => CoverageReport };
    __assets: AssetsDemoHook;
    __viewerDemo: ViewerDemoHook;
  }
}
