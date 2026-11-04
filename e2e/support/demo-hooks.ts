/**
 * Typed handles for the `window.__*` hooks the demo pages expose.
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
    loadMissing: () => Promise<{ ok: boolean; code?: string }>;
    loadUnsupported: () => Promise<{ ok: boolean; code?: string }>;
    runCache: () => Promise<Record<string, unknown>>;
  };
  makeDoc: (assetId: string, sceneId?: string) => unknown;
}

declare global {
  interface Window {
    __demo: HostApiDemoHook;
    __docDemo: DocumentDemoHook;
    __coverage: { report: () => CoverageReport };
    __assets: AssetsDemoHook;
  }
}
